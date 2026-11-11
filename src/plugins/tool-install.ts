import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { gunzipSync, inflateRawSync } from 'zlib';
import { bundledTools } from './bundled-tools';
import { parseToolDescriptor, ToolAsset, toolUrl } from './tool-descriptor';
import { readJsonFile, readPluginManifest } from './manifest';
import { commitPluginInstallation, PluginLinkOptions, pluginPackagesPath, PluginSource } from './store';

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_BINARY = 256 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;

export function isToolSource(input: string): boolean {
  return input.startsWith('tool:') || input.endsWith('.json');
}

/** Explicit redirects keep HTTPS validation on every hop. One deadline includes body reads. */
export async function downloadToolFile(input: string, limit: number): Promise<Buffer> {
  let url = toolUrl(input).href;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Invalid or excessive tool download redirects');
      // GitHub release assets redirect to signed HTTPS URLs. Credentials in userinfo are forbidden;
      // signed query parameters are permitted only on redirects and are never persisted/logged.
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password || next.hash)
        throw new Error('Unsafe tool download redirect');
      url = next.href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Tool download failed (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > limit) throw new Error('Tool download exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
  }
  throw new Error('Tool download redirect limit exceeded');
}

/** Extract exactly the declared regular file; archive paths are never written to disk. */
export async function extractToolBinary(archive: Buffer, asset: ToolAsset): Promise<Buffer> {
  if (asset.format === 'raw') {
    if (!archive.length || archive.length > MAX_BINARY) throw new Error('Invalid binary size');
    return archive;
  }
  if (asset.format === 'zip') {
    const zip = new AdmZip(archive);
    const entries = zip.getEntries();
    if (entries.length > 10_000 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > MAX_EXPANDED)
      throw new Error('Tool archive exceeds expanded size limit');
    const found = entries.filter((entry) => entry.entryName === asset.executable);
    const fileType = found.length === 1 ? (found[0].header.attr >>> 16) & 0o170000 : 0;
    if (
      found.length !== 1 ||
      found[0].isDirectory ||
      (fileType !== 0 && fileType !== 0o100000) ||
      found[0].header.size === 0 ||
      found[0].header.size > MAX_BINARY
    )
      throw new Error('Tool archive must contain one declared regular executable');
    const entry = found[0];
    const data =
      entry.header.method === 0
        ? entry.getCompressedData()
        : entry.header.method === 8
          ? inflateRawSync(entry.getCompressedData(), { maxOutputLength: MAX_BINARY })
          : undefined;
    if (!data || data.length !== entry.header.size) throw new Error('Invalid tool ZIP compression or size');
    return data;
  }
  let binary: Buffer | undefined;
  let expanded = 0;
  let count = 0;
  const chunks: Buffer[] = [];
  const parser = new tar.Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.on('entry', (entry: tar.ReadEntry) => {
      expanded += entry.size;
      count++;
      if (expanded > MAX_EXPANDED || count > 10_000) {
        parser.abort(new Error('Tool archive exceeds expanded size limit'));
        return;
      }
      if (entry.path !== asset.executable) {
        entry.resume();
        return;
      }
      if (
        binary ||
        chunks.length ||
        !['File', 'OldFile'].includes(entry.type) ||
        !entry.size ||
        entry.size > MAX_BINARY
      ) {
        parser.abort(new Error('Tool archive must contain one declared regular executable'));
        return;
      }
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        binary = Buffer.concat(chunks);
      });
      entry.resume();
    });
    try {
      parser.end(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED }));
    } catch (error) {
      reject(error);
    }
  });
  if (!binary) throw new Error('Declared executable is missing from tool archive');
  return binary;
}

export async function installBinaryTool(
  input: string,
  reserved: ReadonlySet<string>,
  options: PluginLinkOptions & { allowScripts?: boolean },
): Promise<{ plugin: ReturnType<typeof readPluginManifest>; source: PluginSource }> {
  if (options.allowScripts) throw new Error('Binary tools do not support installation scripts');
  let value: unknown;
  if (input.startsWith('tool:')) {
    const name = input.slice(5);
    if (!Object.prototype.hasOwnProperty.call(bundledTools, name))
      throw new Error(`Unknown bundled tool descriptor: ${input}`);
    value = bundledTools[name];
  } else if (input.startsWith('https:')) {
    value = JSON.parse((await downloadToolFile(input, 1024 * 1024)).toString('utf8'));
  } else {
    value = readJsonFile(path.resolve(input));
  }
  const tool = parseToolDescriptor(value, true);
  const platform = `${process.platform}-${process.arch}`;
  const asset = tool.platforms![platform];
  if (!asset) throw new Error(`${tool.command} has no binary for ${platform}`);
  if (tool.permissions.some((permission) => !options.allow?.includes(permission)))
    throw new Error(`Tool requires explicit grants: ${tool.permissions.map((p) => `--allow ${p}`).join(' ')}`);
  if (options.allow?.some((permission) => !tool.permissions.includes(permission as (typeof tool.permissions)[number])))
    throw new Error('Only permissions declared by this tool may be granted');
  if (reserved.has(tool.command)) throw new Error(`Tool command ${tool.command} conflicts with a core command`);
  const archive = await downloadToolFile(asset.url, MAX_ARCHIVE);
  if (createHash('sha256').update(archive).digest('hex') !== asset.sha256)
    throw new Error('Binary tool SHA-256 mismatch');
  const binary = await extractToolBinary(archive, asset);
  const id = randomUUID();
  const staging = path.join(pluginPackagesPath(), id);
  const directory = path.join(staging, 'tool');
  let committed = false;
  try {
    // Keep the executable under one host-chosen name, independent of archive paths.
    const entry = `bin/${tool.command}${process.platform === 'win32' ? '.exe' : ''}`;
    fs.mkdirSync(path.join(directory, 'bin'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, entry), binary, { mode: 0o755, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'offckb-tool.json'), JSON.stringify({ ...tool, entry }, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    const descriptorHash = createHash('sha256').update(JSON.stringify(tool)).digest('hex');
    const source: PluginSource = {
      kind: 'binary',
      requested: input.startsWith('tool:') || input.startsWith('https:') ? input : path.resolve(input),
      resolved: `${tool.name}@${tool.version}#sha256:${descriptorHash}`,
    };
    const plugin = commitPluginInstallation(
      directory,
      { id, name: tool.name, source, allowScripts: false },
      reserved,
      options,
      () => {
        committed = true;
      },
    );
    return { plugin, source };
  } finally {
    if (!committed) fs.rmSync(staging, { recursive: true, force: true });
  }
}
