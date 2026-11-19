import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tar from 'tar';
import { randomUUID } from 'crypto';
import { Request } from '../util/request';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';
import { findFileInFolder } from '../util/fs';
import { CatalogEntry } from './catalog';
import {
  addTrustedSource,
  assertNativeRootSafe,
  commitNativeRegistration,
  ensurePluginHome,
  getNativeRecord,
  isSourceTrusted,
  NativeBinaryRecord,
  pluginNativeDir,
  pluginNativeRoot,
} from './store';
import { NativeRelease, isBinaryName, nativeBinaryFileName, readNativeDescriptor } from './manifest';
import { ensureCommandShim } from './shims';

/**
 * Native tool plugin pipeline, generalized from the original
 * ckb-debugger-install.ts flow:
 *
 *   1. Resolve the release tag (the /releases/latest redirect, no GitHub API).
 *   2. Download the platform asset from a deterministic descriptor template.
 *   3. Verify its SHA-256 digest against the published checksum file (fail closed;
 *      the descriptor must declare a checksum template).
 *   4. Extract and stage the binary next to its final location.
 *   5. Probe `--version`; a binary that cannot run is removed, not published.
 *   6. Swap the staged directory into the stable path inside the registry lock.
 *   7. Refresh PATH shims.
 *
 * Sources: the first-party catalog is implicitly trusted. A third-party
 * GitHub repository must be in the local trusted-source allowlist (or be
 * approved alongside with `--trust-source`) before its binary is installed.
 */

export interface NativeToolDescriptor {
  name: string;
  command: string;
  description: string;
  binaryName: string;
  release: NativeRelease;
  minVersion?: string;
  legacyInstallDir?: string;
}

export interface NativeInstallOptions {
  /** What the user typed, recorded in the registry as `requested`. */
  requested: string;
  sourceKind: 'catalog' | 'github';
  /** Approve this source and install in one step (--trust-source). */
  trustSource?: string;
  reserved: ReadonlySet<string>;
}

export interface NativeInstallResult {
  command: string;
  version: string;
  binaryPath: string;
  /** True when the requested version was already installed and no download happened. */
  alreadyInstalled: boolean;
  /** True when a pre-plugin managed binary was adopted instead of downloading. */
  adopted: boolean;
}

/**
 * The `<target>` segment of a release asset name for the current platform.
 * Returns null when the descriptor's release publishes no prebuilt asset.
 *
 * Note: ckb-standalone-debugger stopped publishing `x86_64-apple-darwin`
 * assets after v1.0.0, so an Intel Mac (or Rosetta x64 Node on Apple Silicon)
 * gets the explicit "no prebuilt binary" error instead of a misleading 404.
 */
export function getAssetTarget(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  return null;
}

/**
 * Numeric (not lexicographic) comparison against a required minimum version.
 * A pre-release suffix (e.g. `0.200.0-rc1`) compares older than the plain
 * release of the same segments.
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parse = (v: string): { segments: number[]; prerelease: boolean } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?/.exec(v.trim());
    return match
      ? {
          segments: [Number(match[1]), Number(match[2]), Number(match[3])],
          prerelease: Boolean(match[4]),
        }
      : null;
  };
  const a = parse(version);
  const b = parse(minVersion);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a.segments[i] !== b.segments[i]) {
      return a.segments[i] > b.segments[i];
    }
  }
  // Equal release segments: a pre-release is older than the plain release.
  return a.prerelease === b.prerelease || !a.prerelease;
}

/** Fetch the binary descriptor from a GitHub repository root, or null when absent. */
export async function probeBinaryDescriptor(repository: string, ref?: string): Promise<NativeToolDescriptor | null> {
  const rawRef = ref && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..') ? ref : 'HEAD';
  const url = `https://raw.githubusercontent.com/${repository}/${rawRef}/offckb-plugin.json`;
  const response = await Request.fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the binary tool descriptor at ${url}: HTTP ${response.status}`);
  // Throws on malformed descriptors rather than silently falling back to the
  // npm package flow: a repo that declares a broken binary descriptor means
  // to be a binary tool plugin.
  return readNativeDescriptor(await response.json(), url) as NativeToolDescriptor;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

async function resolveLatestTag(repo: string): Promise<string> {
  // Follow the /releases/latest redirect (no GitHub API, so no per-IP rate
  // limit) and read the tag from the final URL.
  const response = await Request.send(`https://github.com/${repo}/releases/latest`);
  const match = /\/releases\/tag\/([^/?#]+)/.exec(response.url);
  if (!match) {
    throw new Error(`Could not resolve the latest release from https://github.com/${repo}/releases/latest.`);
  }
  return match[1];
}

async function download(url: string, targetPath: string): Promise<void> {
  logger.info(`Downloading ${url} ...`);
  const response = await Request.send(url);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
}

/** Verify the archive against the SHA-256 digest published in the release. */
async function verifyChecksum(checksumUrl: string, archivePath: string): Promise<void> {
  const response = await Request.send(checksumUrl);
  const text = await response.text();
  const match = /([0-9a-f]{64})/i.exec(text);
  if (!match) {
    throw new Error(`Could not read a SHA-256 digest from ${checksumUrl}.`);
  }
  const expected = match[1].toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `SHA-256 checksum mismatch.\nExpected: ${expected}\nActual:   ${actual}\n` +
        'The downloaded file may be corrupted or tampered with.',
    );
  }
  logger.info('SHA-256 checksum verified successfully.');
}

export function getVersionFromBinary(binaryPath: string): string | null {
  try {
    const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }
    const match = /(\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)/.exec(`${result.stdout}${result.stderr || ''}`);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function moveIntoPlace(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(source, target);
    fs.rmSync(source, { force: true });
  }
}

function descriptorFor(entry: NativeToolDescriptor, tag: string, requested: string, sourceKind: 'catalog' | 'github') {
  const id = sourceKind === 'catalog' ? entry.name : entry.release.repo.toLowerCase();
  const record: NativeBinaryRecord = {
    binName: nativeBinaryFileName(entry.binaryName),
    version: tag,
    path: path.join(pluginNativeDir(entry.command), nativeBinaryFileName(entry.binaryName)),
    source: {
      kind: sourceKind,
      id,
      requested,
      resolved: sourceKind === 'catalog' ? `${entry.name}@${tag}` : `github:${entry.release.repo}#${tag}`,
    },
  };
  const descriptor = {
    apiVersion: 1,
    kind: 'binary',
    name: entry.name,
    version: tag,
    command: entry.command,
    description: entry.description,
    binary: { name: entry.binaryName },
    release: entry.release,
    ...(entry.minVersion ? { minVersion: entry.minVersion } : {}),
  };
  return { record, descriptor };
}

/**
 * The current user asked the reviewer to also check rendered asset/checksum
 * names: they become URL path segments, so stay with a plain file basename.
 */
function assertSafeAssetName(name: string, what: string): void {
  if (
    name !== path.basename(name) ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\') ||
    /\{[^}]*\}/.test(name)
  ) {
    throw new Error(`Unsafe ${what} name rendered from the release template: ${name}`);
  }
}

/**
 * Install (or atomically replace) a native tool plugin. `ref` is a release
 * tag or `latest`. Throws on any failure; an existing registration and its
 * binary are left untouched until the staged directory has been fully
 * validated.
 */
export async function installNativeTool(
  entry: NativeToolDescriptor,
  ref: string,
  options: NativeInstallOptions,
): Promise<NativeInstallResult> {
  if (!isBinaryName(entry.binaryName)) throw new Error(`Invalid binary name: ${entry.binaryName}`);
  // Source approval: the catalog is maintained with offckb and implicitly
  // trusted; anything else must be locally approved before a native binary
  // from it lands on this machine (and on PATH). `--trust-source` is a
  // one-shot authorization for this install: the approval is persisted only
  // after the registration commits, so a failed install leaves no permanent
  // trust behind.
  const repo = entry.release.repo.toLowerCase();
  let approveAfterCommit: string | null = null;
  if (options.sourceKind === 'github' && !isSourceTrusted(repo)) {
    if (options.trustSource?.trim().toLowerCase() === repo) {
      approveAfterCommit = repo;
      logger.warn(
        `Installing from unapproved source ${repo} (--trust-source); the approval is recorded only if the install succeeds.`,
      );
    } else {
      throw new Error(
        `${entry.release.repo} is not in the trusted-source allowlist. ` +
          `Review the source, then approve it with: offckb plugin trust add ${entry.release.repo} ` +
          `(or reinstall with --trust-source ${entry.release.repo}).`,
      );
    }
  }

  const target = getAssetTarget(process.platform, process.arch);
  if (!target) {
    throw new Error(`${entry.command} has no prebuilt binary for ${process.platform}/${process.arch}.`);
  }
  const sourceId = options.sourceKind === 'catalog' ? entry.name : entry.release.repo.toLowerCase();
  // Fail before any success path — including idempotent early returns that
  // would otherwise refresh shims for a tampered root.
  assertNativeRootSafe();

  // Every success exit persists a one-shot --trust-source approval, including
  // idempotent reinstalls: revoked sources must be re-approvable by simply
  // re-running an install that succeeds.
  const persistApproval = () => {
    if (!approveAfterCommit) return;
    addTrustedSource(approveAfterCommit);
    logger.warn(
      `Approved ${approveAfterCommit} as a trusted binary tool source; binaries from it run with your user permissions.`,
    );
    approveAfterCommit = null;
  };

  const existing = getNativeRecord(entry.command);

  // Reinstalling an exact tag that is already registered never touches the network.
  if (existing && ref !== 'latest' && existing.version === ref && existing.source.id === sourceId) {
    ensureCommandShim(entry.command, existing.path);
    persistApproval();
    logger.info(`${entry.command} ${ref} is already installed at ${existing.path}.`);
    return { command: entry.command, version: ref, binaryPath: existing.path, alreadyInstalled: true, adopted: false };
  }

  const nativeDir = pluginNativeDir(entry.command);
  // Fail before touching the filesystem when the plugin home cannot hold
  // directories (e.g. OFFCKB_PLUGIN_HOME points at a file).
  ensurePluginHome();
  // Staging paths are derived from the native root; refuse to create them
  // outside the plugin home when the root is a symlink.
  assertNativeRootSafe();
  const staging = path.join(pluginNativeRoot(), `.staging-${entry.command}-${randomUUID()}`);
  let tempDir: string | null = null;
  let adopted = false;
  let tag = ref;
  try {
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const binName = nativeBinaryFileName(entry.binaryName);
    const stagedBinary = path.join(staging, binName);

    // Adopt a leftover pre-plugin managed binary (same layout the old
    // per-tool installers used) instead of re-downloading it. Adoption runs
    // before the latest-tag lookup and is fully offline; the recorded
    // version is read from the binary itself, and the next `@latest`
    // install upgrades it when a newer release exists.
    if (!existing && ref === 'latest' && entry.legacyInstallDir) {
      const legacyBinary = path.join(readSettings().tools.rootFolder, entry.legacyInstallDir, binName);
      if (fs.existsSync(legacyBinary) && !fs.lstatSync(legacyBinary).isSymbolicLink()) {
        const legacyVersion = getVersionFromBinary(legacyBinary);
        if (legacyVersion && (!entry.minVersion || isVersionAtLeast(legacyVersion, entry.minVersion))) {
          logger.info(`Adopting the existing ${entry.command} ${legacyVersion} installation...`);
          // Copy, never move: if any later step fails, the user's working
          // binary is still in place. The legacy directory is removed only
          // after the registry commit succeeds.
          fs.copyFileSync(legacyBinary, stagedBinary);
          if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
          adopted = true;
          tag = legacyVersion;
        }
      }
    }

    if (!adopted) {
      // `latest` resolves the release tag remotely, so an explicit reinstall
      // doubles as the upgrade path; an already-current install only pays the
      // redirect probe below.
      tag = ref === 'latest' ? await resolveLatestTag(entry.release.repo) : ref;
      if (existing && existing.version === tag && existing.source.id === sourceId) {
        ensureCommandShim(entry.command, existing.path);
        persistApproval();
        logger.info(`${entry.command} ${tag} is already installed at ${existing.path}.`);
        return {
          command: entry.command,
          version: tag,
          binaryPath: existing.path,
          alreadyInstalled: true,
          adopted: false,
        };
      }
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `offckb-${entry.command}-`));
      const values = { tag, target, asset: renderTemplate(entry.release.asset, { tag, target }) };
      assertSafeAssetName(values.asset, 'release asset');
      const checksumName = renderTemplate(entry.release.checksum, values);
      assertSafeAssetName(checksumName, 'checksum asset');
      const archivePath = path.join(tempDir, values.asset);
      await download(`https://github.com/${entry.release.repo}/releases/download/${tag}/${values.asset}`, archivePath);
      await verifyChecksum(
        `https://github.com/${entry.release.repo}/releases/download/${tag}/${checksumName}`,
        archivePath,
      );
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      await tar.x({ file: archivePath, cwd: extractDir });
      const extracted = findFileInFolder(extractDir, binName);
      if (!extracted || fs.lstatSync(extracted).isSymbolicLink()) {
        throw new Error(`Binary "${binName}" was not found in the release archive.`);
      }
      moveIntoPlace(extracted, stagedBinary);
      if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
    }

    const version = getVersionFromBinary(stagedBinary);
    if (!version) {
      // The binary cannot run on this system (e.g. incompatible libc).
      // Remove it so the next install does not keep re-adopting or
      // re-downloading the same broken artifact.
      fs.rmSync(stagedBinary, { force: true });
      throw new Error(
        `The installed ${entry.command} binary failed to run \`--version\`. ` +
          'It may be incompatible with this system (e.g. missing glibc).',
      );
    }
    if (entry.minVersion && !isVersionAtLeast(version, entry.minVersion)) {
      logger.warn(
        `${entry.command} ${version} is below the recommended minimum ${entry.minVersion}; ` +
          'some offckb features may not work.',
      );
    }

    const { record, descriptor } = descriptorFor(entry, tag, options.requested, options.sourceKind);
    fs.writeFileSync(path.join(staging, 'offckb-plugin.json'), JSON.stringify(descriptor, null, 2) + '\n', {
      mode: 0o600,
    });

    // Swap the staged directory into the stable path inside the registry
    // lock: a running old binary (EBUSY on Windows) aborts before the
    // registration changes, and a failed registry write rolls the swap back,
    // leaving the previous tool fully usable.
    const backup = `${nativeDir}.backup-${process.pid}-${Date.now()}`;
    let swapped = false;
    commitNativeRegistration(
      entry.command,
      record,
      options.reserved,
      () => {
        if (fs.existsSync(nativeDir)) fs.renameSync(nativeDir, backup);
        try {
          fs.renameSync(staging, nativeDir);
          swapped = true;
        } catch (error) {
          if (fs.existsSync(backup)) fs.renameSync(backup, nativeDir);
          throw error;
        }
      },
      () => {
        // Registry write failed after a successful swap: restore the
        // previous directory so the untouched registration stays truthful.
        if (!swapped) return;
        fs.rmSync(nativeDir, { recursive: true, force: true });
        if (fs.existsSync(backup)) fs.renameSync(backup, nativeDir);
      },
    );
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      logger.warn(`Replaced ${entry.command}, but old package cleanup failed at ${backup}; remove it manually.`);
    }

    ensureCommandShim(entry.command, record.path);
    if (adopted) {
      // The adopted binary copied out of the legacy location; drop the empty
      // shell so nothing probes it as an unmanaged install anymore.
      const legacyDir = path.join(readSettings().tools.rootFolder, entry.legacyInstallDir!);
      try {
        if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        logger.warn(`Adopted ${entry.command}, but legacy cleanup failed at ${legacyDir}; remove it manually.`);
      }
    }
    if (approveAfterCommit) {
      // Persist the one-shot --trust-source approval only now that the binary
      // is actually installed; a failed install leaves no trust behind.
      persistApproval();
    }
    logger.info(`✅ ${entry.command} installed successfully at ${record.path} (version ${version}).`);
    return { command: entry.command, version: tag, binaryPath: record.path, alreadyInstalled: false, adopted };
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will reap the temp dir eventually.
      }
    }
  }
}

/** Resolve a catalog entry into the install descriptor shape. */
export function descriptorFromCatalog(entry: CatalogEntry): NativeToolDescriptor {
  return {
    name: entry.name,
    command: entry.command,
    description: entry.description,
    binaryName: entry.binaryName,
    release: entry.release,
    ...(entry.minVersion ? { minVersion: entry.minVersion } : {}),
    ...(entry.legacyInstallDir ? { legacyInstallDir: entry.legacyInstallDir } : {}),
  };
}
