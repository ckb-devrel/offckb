import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { parseToolDescriptor } from '../src/plugins/tool-descriptor';
import { downloadToolFile, extractToolBinary } from '../src/plugins/tool-install';
import { installPlugin } from '../src/plugins/install';
import { readPluginManifest } from '../src/plugins/manifest';
import { acquirePlugin, getNativeBinaryPath, listPlugins, pluginStoragePaths, removePlugin } from '../src/plugins/store';
import { preparePluginExecution } from '../src/plugins/sandbox';
import ckbCli from '../tools/ckb-cli.json';
import ckbDebugger from '../tools/ckb-debugger.json';
import { catalogEntry } from '../src/plugins/catalog';

let root: string;
let previousHome: string | undefined;
const bytes = Buffer.from('fixture executable');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function descriptor() {
  return {
    apiVersion: 1,
    name: 'native-probe',
    version: '1.0.0',
    command: 'native-probe',
    description: 'Native probe',
    entry: 'bin/probe',
    permissions: [],
    execution: { args: [], env: {} },
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        url: 'https://tools.example/probe',
        sha256: sha256(bytes),
        format: 'raw',
        executable: 'probe',
      },
    },
  };
}
function writeToolDir(value: unknown = descriptor(), binary: Buffer | string = bytes) {
  const dir = path.join(root, 'tool');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'probe'), binary, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'offckb-tool.json'), JSON.stringify(value));
  return dir;
}
const writeDescriptor = writeToolDir; // alias for tests that only swap the descriptor
function mockDownload(binary = bytes) {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(binary));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb native tool '));
  previousHome = process.env.OFFCKB_PLUGIN_HOME;
  process.env.OFFCKB_PLUGIN_HOME = path.join(root, 'home');
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
  else process.env.OFFCKB_PLUGIN_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

it('ships a valid ckb-debugger catalog entry: four platforms, Windows .exe member, adoption metadata', () => {
  const entry = catalogEntry('ckb-debugger');
  expect(entry).toBeDefined();
  const tool = parseToolDescriptor(ckbDebugger, true);
  expect(Object.keys(tool.platforms!)).toEqual(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  // Upstream publishes no Intel-macOS v1.1.2 asset: a missing platform must
  // surface as a clear install error, not a download 404.
  expect(tool.platforms!['darwin-x64']).toBeUndefined();
  // The Windows archive member is the real .exe (verified against the
  // upstream v1.1.2 archive).
  expect(tool.platforms!['win32-x64'].executable).toBe('ckb-debugger.exe');
  expect(entry!.install.minVersion).toBe('0.200.0');
  expect(entry!.install.legacyInstallDir).toBe('ckb-debugger');
});

it('ships a valid ckb-cli descriptor with pinned official assets, not an implicit installation', () => {
  const tool = parseToolDescriptor(ckbCli, true);
  expect(Object.keys(tool.platforms!)).toHaveLength(5);
  expect(tool.permissions).toEqual(['devnet-read']);
  expect(tool.execution.env.CKB_CLI_HOME).toBe('${plugin.dataPath}');
  expect(fs.existsSync(process.env.OFFCKB_PLUGIN_HOME!)).toBe(false);
});

it.each([
  [undefined, { args: [], env: {} }],
  [null, { args: [], env: {} }],
  [{}, { args: [], env: {} }],
  [{ args: ['--example'] }, { args: ['--example'], env: {} }],
  [{ env: { TOOL_HOME: '${plugin.dataPath}' } }, { args: [], env: { TOOL_HOME: '${plugin.dataPath}' } }],
])('defaults omitted execution fields independently: %j', (execution, expected) => {
  expect(parseToolDescriptor({ ...descriptor(), execution }).execution).toEqual(expected);
});

it.each([
  false,
  0,
  '',
  'invalid',
  [],
  { args: null },
  { args: '--example' },
  { env: null },
  { env: [] },
  { env: false },
])('rejects malformed execution values rather than defaulting them: %j', (execution) => {
  expect(() => parseToolDescriptor({ ...descriptor(), execution })).toThrow(
    'Invalid binary tool arguments or environment bindings',
  );
});

it.each([
  { version: null },
  { version: 'latest' },
  { command: '../escape' },
  { command: 'con' },
  { name: '../escape' },
  { entry: '../escape' },
  { entry: '/bin/probe' },
  { entry: 'C:\\probe.exe' },
  { permissions: ['devnet-write'] },
  { execution: { args: ['${settings.privateKey}'], env: {} } },
  { execution: { args: ['${devnet.rpcUrl}'], env: {} } },
  { execution: { args: [], env: { NODE_OPTIONS: '--require bad' } } },
  { execution: { args: [], env: { HTTPS_PROXY: 'https://bad' } } },
  { platforms: { 'linux-x64': { url: 'http://insecure/a', sha256: '0'.repeat(64), format: 'raw', executable: 'a' } } },
])('rejects unsafe or unsupported descriptor fields %j', (override) => {
  expect(() => parseToolDescriptor({ ...descriptor(), ...override }, true)).toThrow();
});

it('installs a local directory, snapshots it, preserves storage on replacement, and removes managed files', async () => {
  const directory = writeToolDir();
  const first = await installPlugin(directory, new Set());
  expect(first.plugin.kind).toBe('binary');
  expect(first.source.kind).toBe('descriptor');
  expect(fs.readFileSync(first.plugin.entry!)).toEqual(bytes);
  // The user's directory is referenced, never moved.
  expect(fs.existsSync(path.join(directory, 'bin', 'probe'))).toBe(true);
  const data = pluginStoragePaths(first.plugin.name).data;
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'keep'), 'saved');
  fs.writeFileSync(path.join(directory, 'offckb-tool.json'), 'managed copy is not read at runtime');
  expect(listPlugins(new Set())[0].state).toBe('available');
  const lease = acquirePlugin(first.plugin.command);
  writeToolDir({ ...descriptor(), version: '1.1.0' });
  await expect(installPlugin(directory, new Set(), { trust: true })).rejects.toThrow('running');
  lease.release();
  const second = await installPlugin(directory, new Set());
  // Replacement swaps the directory contents in place at the stable path;
  // the previous version and its managed files are gone.
  expect(second.plugin.directory).toBe(first.plugin.directory);
  expect(second.plugin.version).toBe('1.1.0');
  expect(fs.readdirSync(second.plugin.directory).some((name) => name.includes('.backup-'))).toBe(false);
  expect(fs.readFileSync(path.join(data, 'keep'), 'utf8')).toBe('saved');
  removePlugin(second.plugin.command);
  expect(fs.existsSync(second.plugin.directory)).toBe(false);
  expect(fs.readFileSync(path.join(data, 'keep'), 'utf8')).toBe('saved');
});

it('no longer installs remote or file descriptors; only local directories are binary sources', async () => {
  await expect(installPlugin('https://third-party.example/tool.json', new Set())).rejects.toThrow(
    'Unknown plugin source',
  );
  const file = path.join(root, 'tool.json');
  fs.writeFileSync(file, JSON.stringify(descriptor()));
  await expect(installPlugin(file, new Set())).rejects.toThrow('Unknown plugin source');
});

it('rejects scripts, missing grants, bad entries and conflicts before touching executable code', async () => {
  const directory = writeToolDir({ ...descriptor(), permissions: ['devnet-read'] });
  await expect(installPlugin(directory, new Set(), { allowScripts: true, trust: true })).rejects.toThrow('scripts');
  await expect(installPlugin(directory, new Set())).rejects.toThrow('--allow devnet-read');
  await expect(installPlugin(directory, new Set(['native-probe']), { allow: ['devnet-read'] })).rejects.toThrow(
    'conflicts',
  );
  // A directory without a readable offckb-tool.json is not a tool source.
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  await expect(installPlugin(empty, new Set())).rejects.toThrow();
  // An escaping entry is rejected before anything is copied.
  writeToolDir({ ...descriptor(), entry: '../escape' });
  await expect(installPlugin(directory, new Set())).rejects.toThrow();
});

it('keeps the prior installation when a replacement fails', async () => {
  const directory = writeToolDir();
  const first = await installPlugin(directory, new Set());
  // Break the entry (non-executable on POSIX): the replacement must fail
  // closed and leave the previous managed copy untouched.
  fs.chmodSync(path.join(directory, 'bin', 'probe'), 0o644);
  if (process.platform !== 'win32') await expect(installPlugin(directory, new Set())).rejects.toThrow();
  expect(fs.realpathSync(listPlugins(new Set())[0].directory)).toBe(first.plugin.directory);
  expect(fs.readFileSync(getNativeBinaryPath('native-probe')!)).toEqual(bytes);
});

it('bounds downloads, rejects HTTP/credentialed sources and HTTPS downgrades, and follows signed release redirects', async () => {
  const fetcher = mockDownload();
  await expect(downloadToolFile('http://tools.example/a', 100)).rejects.toThrow('HTTPS');
  await expect(downloadToolFile('https://user:secret@tools.example/a', 100)).rejects.toThrow('HTTPS');
  await expect(downloadToolFile('https://tools.example/a', 1)).rejects.toThrow('size limit');
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://tools.example/a' } }));
  await expect(downloadToolFile('https://tools.example/a', 100)).rejects.toThrow('Unsafe');
  fetcher.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: 'https://assets.example/a?signature=example' } }),
  );
  expect(await downloadToolFile('https://tools.example/a', 100)).toEqual(bytes);
});

it('extracts only the exact declared regular ZIP file and rejects symlinks or missing entries', async () => {
  const zip = new AdmZip();
  zip.addFile('release/probe', bytes);
  zip.addFile('../escape', Buffer.from('ignored, never extracted'));
  const asset = { url: 'https://tools.example/a', sha256: '', format: 'zip' as const, executable: 'release/probe' };
  expect(await extractToolBinary(zip.toBuffer(), asset)).toEqual(bytes);
  expect(fs.existsSync(path.join(root, 'escape'))).toBe(false);
  await expect(extractToolBinary(zip.toBuffer(), { ...asset, executable: 'absent' })).rejects.toThrow('regular');
  zip.getEntry('release/probe')!.header.attr = (0o120777 << 16) >>> 0;
  await expect(extractToolBinary(zip.toBuffer(), asset)).rejects.toThrow('regular');
});

it('extracts a regular tar.gz member without writing archive paths and rejects links', async () => {
  fs.writeFileSync(path.join(root, 'probe'), bytes);
  const archive = path.join(root, 'archive.tar.gz');
  await tar.c({ cwd: root, file: archive, gzip: true }, ['probe']);
  const asset = { url: 'https://tools.example/a', sha256: '', format: 'tar.gz' as const, executable: 'probe' };
  expect(await extractToolBinary(fs.readFileSync(archive), asset)).toEqual(bytes);
  if (process.platform !== 'win32') {
    fs.symlinkSync('probe', path.join(root, 'link'));
    await tar.c({ cwd: root, file: archive, gzip: true }, ['link']);
    await expect(extractToolBinary(fs.readFileSync(archive), { ...asset, executable: 'link' })).rejects.toThrow(
      'regular',
    );
  }
});

it('links native entries without executing metadata and rejects escaping executable symlinks', () => {
  fs.writeFileSync(path.join(root, 'offckb-tool.json'), JSON.stringify({ ...descriptor(), entry: 'probe' }));
  fs.writeFileSync(path.join(root, 'probe'), bytes, { mode: 0o755 });
  if (process.platform === 'win32') return;
  expect(readPluginManifest(root)).toMatchObject({ kind: 'binary', command: 'native-probe' });
  fs.unlinkSync(path.join(root, 'probe'));
  fs.symlinkSync('/bin/echo', path.join(root, 'probe'));
  expect(() => readPluginManifest(root)).toThrow('inside');
});

it('refuses sandbox preparation for binary tools; they always run natively', async () => {
  const entry = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(root, entry));
  fs.writeFileSync(
    path.join(root, 'offckb-tool.json'),
    JSON.stringify({ ...descriptor(), entry, permissions: [] }),
  );
  const plugin = readPluginManifest(root);
  await expect(preparePluginExecution(plugin, undefined, [], ['--help'], 0, 'sandbox')).rejects.toThrow(
    'cannot run in the sandbox',
  );
});

it('executes a real native entry directly with literal argv, isolated storage binding and offline help', async () => {
  const entry = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(root, entry));
  fs.chmodSync(path.join(root, entry), 0o755);
  fs.writeFileSync(
    path.join(root, 'offckb-tool.json'),
    JSON.stringify({
      ...descriptor(),
      entry,
      execution: {
        args: [
          '-e',
          'console.log(JSON.stringify({args:process.argv.slice(1),home:process.env.TOOL_HOME}))',
          '--',
          '${plugin.dataPath}',
          '$(never executed)',
        ],
        env: { TOOL_HOME: '${plugin.dataPath}' },
      },
    }),
  );
  const plugin = readPluginManifest(root);
  const execution = await preparePluginExecution(plugin, undefined, [], ['a b', '--', '$literal'], 0, 'trusted');
  try {
    expect(execution.command).toBe(plugin.entry);
    expect(execution.env.TOOL_HOME).toBe(execution.args[3]);
    const result = spawnSync(execution.command, execution.args, { env: execution.env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: [execution.env.TOOL_HOME, '$(never executed)', 'a b', '--', '$literal'],
      home: execution.env.TOOL_HOME,
    });
  } finally {
    execution.dispose();
  }
  const help = await preparePluginExecution(plugin, undefined, [], ['--help'], 0, 'trusted');
  try {
    expect(help.args).toEqual(['--help']);
  } finally {
    help.dispose();
  }
  plugin.permissions = ['devnet-read'];
  plugin.execution!.env.TOOL_RPC = '${devnet.rpcUrl}';
  const rpcHelp = await preparePluginExecution(plugin, undefined, [], ['--help'], 0, 'trusted');
  try {
    expect(rpcHelp.env.TOOL_RPC).toBe('');
  } finally {
    rpcHelp.dispose();
  }
});
