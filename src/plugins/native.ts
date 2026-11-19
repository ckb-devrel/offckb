import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import * as tar from 'tar';
import { Request } from '../util/request';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';
import { findFileInFolder } from '../util/fs';
import { CatalogEntry } from './catalog';
import {
  NativeBinaryRecord,
  addTrustedSource,
  assertNativeRootSafe,
  commitNativeRegistration,
  ensurePluginHome,
  getNativeRecord,
  isSourceTrusted,
  NativeSource,
  pluginNativeDir,
  pluginNativeRoot,
} from './store';
import { NativeRelease, PluginPermission, isBinaryName, nativeBinaryFileName, readNativeDescriptor } from './manifest';
import { ToolAsset, ToolExecution, parseToolDescriptor } from './tool-descriptor';
import { downloadToolFile, extractToolBinary, MAX_ARCHIVE } from './tool-install';
import { ensureCommandShim } from './shims';

/**
 * Native tool plugin pipeline. Binary tools are installed into a stable,
 * host-owned directory and exposed through a stable path, PATH shims and
 * OFFCKB_TOOL_* env vars so other tools can spawn them directly (issue #555).
 *
 * Two download shapes feed one staging/commit tail:
 *   - release templates (first-party catalog): the latest tag is resolved
 *     from the release redirect, the archive verified against the published
 *     checksum file (fail closed);
 *   - explicit per-platform descriptors (bundled tools, local/HTTPS tool
 *     descriptors, third-party GitHub repos): URLs and SHA-256 digests are
 *     pinned in the descriptor itself.
 *
 * Source trust:
 *   - catalog and bundled tools ship with offckb (implicitly trusted);
 *   - explicit descriptors pin their own content (trust the content);
 *   - third-party GitHub sources require the local trusted-source allowlist
 *     (--trust-source approves alongside a successful install).
 */

export interface NativeToolInstall {
  name: string;
  command: string;
  description: string;
  /** Pinned descriptor version (explicit platforms sources). */
  version?: string;
  /** Source repository for github sources (approval and identity). */
  repository?: string;
  /** Declared host-provided capabilities; every one needs an explicit grant. */
  permissions?: PluginPermission[];
  minVersion?: string;
  legacyInstallDir?: string;
  execution?: ToolExecution;
  /** Exactly one download shape. */
  release?: NativeRelease;
  platforms?: Record<string, ToolAsset>;
}

export interface NativeInstallOptions {
  /** What the user typed, recorded in the registry as `requested`. */
  requested: string;
  sourceKind: NativeSource['kind'];
  /** Approve this source and install it in one step (--trust-source). */
  trustSource?: string;
  /** Capability grants for descriptors that declare permissions. */
  allow?: string[];
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
 * The `<target>` segment of a ckb-standalone-debugger release asset name for
 * the current platform. Template-based (catalog) sources only; explicit
 * descriptors carry their own per-platform URLs.
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
export async function probeBinaryDescriptor(
  repository: string,
  ref?: string,
): Promise<{ install: NativeToolInstall; tag: string } | null> {
  let tag: string;
  if (ref && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..')) {
    tag = ref;
  } else {
    try {
      tag = await resolveLatestTag(repository);
    } catch {
      // Repositories without releases (e.g. npm-shaped JS plugin sources)
      // cannot resolve a latest tag; probe the default branch instead so
      // those still fall through to the npm install path on a 404.
      tag = 'HEAD';
    }
  }
  const url = `https://raw.githubusercontent.com/${repository}/${tag}/offckb-tool.json`;
  const response = await Request.fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the binary tool descriptor at ${url}: HTTP ${response.status}`);
  // Throws on malformed descriptors rather than silently falling back to the
  // npm package flow: a repo that declares a broken binary descriptor means
  // to be a binary tool plugin.
  const tool = parseToolDescriptor(await response.json(), true);
  return {
    install: {
      name: tool.name,
      version: tool.version,
      command: tool.command,
      description: tool.description,
      permissions: tool.permissions,
      execution: tool.execution,
      platforms: tool.platforms,
    },
    tag,
  };
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

/**
 * Rendered asset/checksum names become URL path segments: they must stay
 * plain basenames with no traversal or unreplaced placeholders.
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

interface PlannedInstall {
  version: string;
  /** Canonical descriptor written next to the installed binary. */
  descriptor: Record<string, unknown>;
  binary: Buffer | string;
  /** True when `binary` is a staged file path (template path) rather than a Buffer. */
  binaryIsFile: boolean;
  descriptorHash: string;
  /** Scratch directory holding `binary`; removed after the swap is staged. */
  tempDir?: string;
}

/** Plan the download/verification half for an explicit per-platform descriptor. */
async function planPlatformsInstall(tool: NativeToolInstall): Promise<PlannedInstall> {
  const platform = `${process.platform}-${process.arch}`;
  const asset = tool.platforms![platform];
  if (!asset) {
    throw new Error(`${tool.command} has no binary for ${process.platform}/${process.arch}.`);
  }
  const archive = await downloadToolFile(asset.url, MAX_ARCHIVE);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  if (sha256 !== asset.sha256) {
    throw new Error('Binary tool SHA-256 mismatch');
  }
  const binary = await extractToolBinary(archive, asset);
  const descriptor = {
    apiVersion: 1,
    name: tool.name,
    version: tool.version!,
    command: tool.command,
    description: tool.description,
    entry: '',
    permissions: [],
    ...(tool.execution ? { execution: tool.execution } : {}),
    platforms: { [platform]: { ...asset, sha256 } },
  };
  const descriptorHash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { version: tool.version!, descriptor, binary, binaryIsFile: false, descriptorHash };
}

/** Plan the download/verification half for a release-template (catalog) source. */
async function planTemplateInstall(tool: NativeToolInstall, tag: string): Promise<PlannedInstall> {
  const target = getAssetTarget(process.platform, process.arch);
  if (!target) {
    throw new Error(`${tool.command} has no prebuilt binary for ${process.platform}/${process.arch}.`);
  }
  const values = { tag, target, asset: renderTemplate(tool.release!.asset, { tag, target }) };
  assertSafeAssetName(values.asset, 'release asset');
  const checksumName = renderTemplate(tool.release!.checksum, values);
  assertSafeAssetName(checksumName, 'checksum asset');
  const archiveUrl = `https://github.com/${tool.release!.repo}/releases/download/${tag}/${values.asset}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `offckb-${tool.command}-`));
  try {
    const archivePath = path.join(tempDir, values.asset);
    await download(archiveUrl, archivePath);
    await verifyChecksum(
      `https://github.com/${tool.release!.repo}/releases/download/${tag}/${checksumName}`,
      archivePath,
    );
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await tar.x({ file: archivePath, cwd: extractDir });
    const binName = nativeBinaryFileName(tool.command);
    const extracted = findFileInFolder(extractDir, binName);
    if (!extracted || fs.lstatSync(extracted).isSymbolicLink()) {
      throw new Error(`Binary "${binName}" was not found in the release archive.`);
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(extracted)).digest('hex');
    const descriptor = {
      apiVersion: 1,
      name: tool.name,
      version: tag,
      command: tool.command,
      description: tool.description,
      entry: '',
      permissions: [],
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          url: archiveUrl,
          sha256,
          format: 'tar.gz',
          executable: binName,
        },
      },
    };
    const descriptorHash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
    // The caller moves the extracted binary out of tempDir before this
    // directory is removed (see installNativeTool's cleanup).
    return { version: tag, descriptor, binary: extracted, binaryIsFile: true, descriptorHash, tempDir };
  } finally {
    // Remove only the downloaded archive here; the extracted binary stays
    // until the caller has moved it out of the scratch directory.
    try {
      fs.rmSync(path.join(tempDir, values.asset), { force: true });
    } catch {
      // The OS reaps the temp dir eventually.
    }
  }
}

/**
 * Install (or atomically replace) a native tool plugin. Throws on any
 * failure; an existing registration and its binary are left untouched until
 * the staged directory has been fully validated and committed.
 */
export async function installNativeTool(
  tool: NativeToolInstall,
  ref: string,
  options: NativeInstallOptions,
): Promise<NativeInstallResult> {
  if (!isBinaryName(tool.command)) throw new Error(`Invalid binary tool command: ${tool.command}`);
  if ((tool.release ? 1 : 0) + (tool.platforms ? 1 : 0) !== 1) {
    throw new Error('A native tool install needs exactly one of release templates or explicit platforms');
  }
  if (tool.release && !tool.name) throw new Error('Invalid tool name');
  // Source approval: catalog/bundled ship with offckb and are implicitly
  // trusted; explicit descriptors pin their own content; third-party GitHub
  // sources require the local allowlist. `--trust-source` is a one-shot
  // authorization persisted only after a successful install.
  const repo = tool.repository;
  let approveAfterCommit: string | null = null;
  if (options.sourceKind === 'github') {
    const sourceRepo = String(repo).toLowerCase();
    if (!isSourceTrusted(sourceRepo)) {
      if (options.trustSource?.trim().toLowerCase() === sourceRepo) {
        approveAfterCommit = sourceRepo;
        logger.warn(
          `Installing from unapproved source ${sourceRepo} (--trust-source); the approval is recorded only if the install succeeds.`,
        );
      } else {
        throw new Error(
          `${repo} is not in the trusted-source allowlist. ` +
            `Review the source, then approve it with: offckb plugin trust add ${repo} ` +
            `(or reinstall with --trust-source ${repo}).`,
        );
      }
    }
  }
  const sourceId =
    options.sourceKind === 'catalog'
      ? tool.name
      : options.sourceKind === 'github'
        ? String(repo).toLowerCase()
        : options.sourceKind === 'bundled'
          ? `tool:${tool.name}`
          : tool.name;
  const resolvedPrefix =
    options.sourceKind === 'catalog'
      ? `${tool.name}@`
      : options.sourceKind === 'github'
        ? `github:${repo}#`
        : options.sourceKind === 'bundled'
          ? `tool:${tool.name}@`
          : `${tool.name}@`;

  // Fail before touching anything when the plugin home cannot hold
  // directories or the native root is tampered.
  ensurePluginHome();
  assertNativeRootSafe();

  // Capability grants: every declared permission needs an explicit --allow,
  // and only declared permissions may be granted (validated before any
  // executable content is staged for descriptor sources by tool-install).
  const declaredPermissions = tool.permissions ?? [];
  if (declaredPermissions.some((permission) => !options.allow?.includes(permission))) {
    throw new Error(
      `Tool requires explicit grants: ${declaredPermissions.map((permission) => `--allow ${permission}`).join(' ')}`,
    );
  }
  if (options.allow?.some((permission) => !declaredPermissions.includes(permission as PluginPermission))) {
    throw new Error('Only permissions declared by this tool may be granted');
  }

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

  // Idempotent offline path: template sources with an exact tag, and any
  // pinned immutable source whose version is already registered. Local or
  // HTTPS descriptor files always reinstall: their content may change at a
  // constant version, so the pinned SHA-256 must be re-verified every time.
  const existing = getNativeRecord(tool.command);
  const immutableSource = options.sourceKind !== 'descriptor';
  const pinnedVersion = tool.platforms
    ? options.sourceKind === 'github'
      ? ref
      : (tool.version ?? null)
    : ref !== 'latest'
      ? ref
      : null;
  if (
    existing &&
    immutableSource &&
    pinnedVersion &&
    existing.version === pinnedVersion &&
    existing.source.id === sourceId
  ) {
    ensureCommandShim(tool.command, existing.path);
    persistApproval();
    logger.info(`${tool.command} ${pinnedVersion} is already installed at ${existing.path}.`);
    return {
      command: tool.command,
      version: pinnedVersion,
      binaryPath: existing.path,
      alreadyInstalled: true,
      adopted: false,
    };
  }

  const nativeDir = pluginNativeDir(tool.command);
  const staging = path.join(pluginNativeRoot(), `.staging-${tool.command}-${randomUUID()}`);
  let adopted = false;
  let plannedTempDir: string | undefined;
  try {
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const binName = nativeBinaryFileName(tool.command);
    const stagedBinary = path.join(staging, binName);
    // Assigned either by the offline legacy adoption or by the download plan.
    let planned!: PlannedInstall;

    // Adopt a leftover pre-plugin managed binary (same layout the old
    // per-tool installers used) instead of re-downloading it. Runs before
    // the latest-tag lookup and is fully offline; the recorded version is
    // read from the binary itself, and the next `@latest` install upgrades
    // it when a newer release exists.
    if (!existing && ref === 'latest' && tool.legacyInstallDir) {
      const legacyBinary = path.join(readSettings().tools.rootFolder, tool.legacyInstallDir, binName);
      if (fs.existsSync(legacyBinary) && !fs.lstatSync(legacyBinary).isSymbolicLink()) {
        const legacyVersion = getVersionFromBinary(legacyBinary);
        if (legacyVersion && (!tool.minVersion || isVersionAtLeast(legacyVersion, tool.minVersion))) {
          logger.info(`Adopting the existing ${tool.command} ${legacyVersion} installation...`);
          // Copy, never move: if any later step fails, the user's working
          // binary is still in place. The legacy directory is removed only
          // after the registry commit succeeds.
          fs.copyFileSync(legacyBinary, stagedBinary);
          if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);
          planned = {
            version: legacyVersion,
            descriptor: {
              apiVersion: 1,
              name: tool.name,
              version: legacyVersion,
              command: tool.command,
              description: tool.description,
              entry: binName,
              permissions: [],
            },
            binary: stagedBinary,
            binaryIsFile: true,
            descriptorHash: '',
          };
          adopted = true;
        }
      }
    }

    if (!adopted) {
      if (tool.release) {
        // Resolve the tag first so an already-current `@latest` check only
        // pays the redirect probe: no archive download for identical tags.
        const tag = ref === 'latest' ? await resolveLatestTag(tool.release.repo) : ref;
        if (existing && existing.version === tag && existing.source.id === sourceId) {
          ensureCommandShim(tool.command, existing.path);
          persistApproval();
          logger.info(`${tool.command} ${tag} is already installed at ${existing.path}.`);
          return {
            command: tool.command,
            version: tag,
            binaryPath: existing.path,
            alreadyInstalled: true,
            adopted: false,
          };
        }
        planned = await planTemplateInstall(tool, tag);
      } else {
        planned = await planPlatformsInstall({ ...tool, version: tool.version ?? pinnedVersion ?? '' });
        // GitHub provenance records the resolved release tag; the on-disk
        // descriptor keeps the descriptor's own version field.
        if (options.sourceKind === 'github') planned.version = ref;
      }
      plannedTempDir = planned.tempDir;
    }

    if (planned.binaryIsFile) {
      if (path.resolve(String(planned.binary)) !== path.resolve(stagedBinary)) {
        moveIntoPlace(String(planned.binary), stagedBinary);
      }
    } else {
      fs.writeFileSync(stagedBinary, planned.binary as Buffer, { mode: 0o755 });
    }
    if (process.platform !== 'win32') fs.chmodSync(stagedBinary, 0o755);

    const probed = getVersionFromBinary(stagedBinary);
    let version: string;
    if (!probed) {
      if (tool.platforms) {
        // Content-pinned descriptors trust the SHA-256, not runnability: a
        // cross-built or fixture binary may not execute here. Record the
        // pinned descriptor version instead of failing the install.
        logger.warn(
          `The installed ${tool.command} binary did not report a version; recording the pinned descriptor version ${planned.version}.`,
        );
        version = planned.version;
      } else {
        // Template sources trust the repository and published checksum, so
        // the binary must prove it can run before being published.
        fs.rmSync(stagedBinary, { force: true });
        throw new Error(
          `The installed ${tool.command} binary failed to run \`--version\`. ` +
            'It may be incompatible with this system (e.g. missing glibc).',
        );
      }
    } else {
      version = probed;
    }
    if (tool.minVersion && !isVersionAtLeast(version, tool.minVersion)) {
      logger.warn(
        `${tool.command} ${version} is below the recommended minimum ${tool.minVersion}; ` +
          'some offckb features may not work.',
      );
    }

    const descriptor = { ...planned.descriptor, entry: binName };
    fs.writeFileSync(path.join(staging, 'offckb-tool.json'), JSON.stringify(descriptor, null, 2) + '\n', {
      mode: 0o600,
    });

    const record: NativeBinaryRecord = {
      binName,
      version: planned.version,
      path: path.join(nativeDir, binName),
      source: {
        kind: options.sourceKind,
        id: sourceId,
        requested: options.requested,
        resolved:
          `${resolvedPrefix}${planned.version}` + (planned.descriptorHash ? `#sha256:${planned.descriptorHash}` : ''),
      },
    };

    // Swap the staged directory into the stable path inside the registry
    // lock: a running old binary (EBUSY on Windows) aborts before the
    // registration changes, and a failed registry write rolls the swap back,
    // leaving the previous tool fully usable.
    const backup = `${nativeDir}.backup-${process.pid}-${Date.now()}`;
    let swapped = false;
    commitNativeRegistration(
      tool.command,
      record,
      (options.allow ?? []) as PluginPermission[],
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
      logger.warn(`Replaced ${tool.command}, but old package cleanup failed at ${backup}; remove it manually.`);
    }

    ensureCommandShim(tool.command, record.path);
    if (adopted) {
      // The adopted binary copied out of the legacy location; drop the empty
      // shell so nothing probes it as an unmanaged install anymore.
      const legacyDir = path.join(readSettings().tools.rootFolder, tool.legacyInstallDir!);
      try {
        if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        logger.warn(`Adopted ${tool.command}, but legacy cleanup failed at ${legacyDir}; remove it manually.`);
      }
    }
    persistApproval();
    logger.info(`✅ ${tool.command} installed successfully at ${record.path} (version ${version}).`);
    return {
      command: tool.command,
      version: planned.version,
      binaryPath: record.path,
      alreadyInstalled: false,
      adopted,
    };
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (plannedTempDir) {
      try {
        fs.rmSync(plannedTempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will reap the temp dir eventually.
      }
    }
  }
}

/** Resolve a catalog entry into the install shape. */
export function descriptorFromCatalog(entry: CatalogEntry): NativeToolInstall {
  return {
    name: entry.name,
    command: entry.command,
    description: entry.description,
    permissions: [],
    release: entry.release,
    ...(entry.minVersion ? { minVersion: entry.minVersion } : {}),
    ...(entry.legacyInstallDir ? { legacyInstallDir: entry.legacyInstallDir } : {}),
  };
}

// Re-exported for the legacy descriptor reader.
export { readNativeDescriptor };
