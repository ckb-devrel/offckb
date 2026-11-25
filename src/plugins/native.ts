import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';
import {
  NativeBinaryRecord,
  assertNativeRootSafe,
  commitNativeRegistration,
  ensurePluginHome,
  getNativeRecord,
  getNativeRegistration,
  NativeSource,
  updateNativeGrants,
  pluginNativeDir,
  pluginNativeRoot,
} from './store';
import { PluginPermission, isBinaryName, nativeBinaryFileName, readNativeDescriptor } from './manifest';
import { ToolAsset, ToolExecution } from './tool-descriptor';
import { downloadToolFile, extractToolBinary, MAX_ARCHIVE } from './tool-install';
import { ensureCommandShim } from './shims';

/**
 * Native tool plugin pipeline. Binary tools are installed into a stable,
 * host-owned directory and exposed through a stable path, PATH shims and
 * OFFCKB_TOOL_* env vars so other tools can spawn them directly (issue #555).
 *
 * Every source (the first-party catalog and local directory descriptors)
 * feeds one shape: per-platform URLs and SHA-256 digests pinned in the
 * descriptor and verified against the downloaded bytes, or a declared
 * executable copied from a local directory.
 *
 * Source trust: catalog tools ship with offckb (implicitly trusted, pinned
 * per release); local directory descriptors pin their own content by copying
 * the declared executable.
 */

export interface NativeToolInstall {
  name: string;
  command: string;
  description: string;
  /** Pinned descriptor version (explicit platforms sources). */
  version?: string;
  /** Declared host-provided capabilities; every one needs an explicit grant. */
  permissions?: PluginPermission[];
  minVersion?: string;
  legacyInstallDir?: string;
  execution?: ToolExecution;
  platforms: Record<string, ToolAsset>;
  /** Descriptor-declared executable, relative to the package root. */
  entry?: string;
  /** Local directory sources: copy this declared executable instead of downloading. */
  localDirectory?: string;
}

export interface NativeInstallOptions {
  /** What the user typed, recorded in the registry as `requested`. */
  requested: string;
  sourceKind: NativeSource['kind'];
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
 * A legacyInstallDir segment names the pre-plugin install directory adopted
 * from under the tools root. It must be a single plain directory name: the
 * adoption copies from it and later deletes it recursively, so a traversal
 * or the tools root itself ('.') would be catastrophic. Shared by the
 * catalog loader and the installer.
 */
export function isSafeLegacySegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) && !segment.includes('..');
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

export function getVersionFromBinary(binaryPath: string): string | null {
  try {
    // A wedged binary must never block the install: hard deadline, child killed.
    const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
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
    permissions: tool.permissions ?? [],
    ...(tool.execution ? { execution: tool.execution } : {}),
    platforms: { [platform]: { ...asset, sha256 } },
  };
  const descriptorHash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { version: tool.version!, descriptor, binary, binaryIsFile: false, descriptorHash };
}

/** Plan a local directory source: validate and copy the declared executable. */
function planLocalInstall(tool: NativeToolInstall): PlannedInstall {
  const directory = tool.localDirectory!;
  const declared = path.resolve(directory, tool.entry!);
  const resolved = fs.realpathSync(declared);
  if (resolved !== declared || !resolved.startsWith(directory + path.sep))
    throw new Error(`Binary tool entry must be a regular file inside ${directory}`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || fs.lstatSync(resolved).isSymbolicLink())
    throw new Error(`Binary tool entry must be a regular file: ${tool.entry}`);
  const windows = process.platform === 'win32';
  if (windows && !resolved.toLowerCase().endsWith('.exe'))
    throw new Error('Binary tool entries on Windows must be .exe files');
  if (!windows) fs.accessSync(resolved, fs.constants.X_OK); // throws without the executable bit
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `offckb-${tool.command}-`));
  const scratch = path.join(tempDir, path.basename(resolved));
  // Copy, never move: the user's directory stays intact on any failure.
  fs.copyFileSync(resolved, scratch);
  if (!windows) fs.chmodSync(scratch, 0o755);
  const descriptor = {
    apiVersion: 1,
    name: tool.name,
    version: tool.version!,
    command: tool.command,
    description: tool.description,
    entry: '',
    permissions: tool.permissions ?? [],
    ...(tool.execution ? { execution: tool.execution } : {}),
  };
  const descriptorHash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { version: tool.version!, descriptor, binary: scratch, binaryIsFile: true, descriptorHash, tempDir };
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
  if (!tool.localDirectory && (!tool.platforms || !Object.keys(tool.platforms).length))
    throw new Error('A native tool install requires pinned platform assets or a local directory');
  // Source trust: catalog tools ship with offckb and are implicitly trusted
  // (pinned per release); local directory descriptors pin their own content.
  const sourceId = tool.name;
  const resolvedPrefix = `${tool.name}@`;

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

  // A same-version reinstall must not silently keep the previous grants.
  const applyGrantChanges = (command: string) => {
    const requested = [...(options.allow ?? [])].sort();
    const installed = getNativeRegistration(command);
    if (installed && JSON.stringify(installed.permissions) !== JSON.stringify(requested)) {
      updateNativeGrants(command, (options.allow ?? []) as PluginPermission[]);
      logger.info(`Updated ${command} capability grants: ${requested.join(', ') || '(none)'}`);
    }
  };

  // Idempotent offline path: a pinned immutable source whose version is
  // already registered short-circuits without network. Local directory
  // descriptors always reinstall: their content may change at a constant
  // version, so the executable must be re-copied and re-validated.
  const existing = getNativeRecord(tool.command);
  const immutableSource = options.sourceKind !== 'descriptor' && ref !== 'HEAD';
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
    ensureCommandShim(tool.command, existing.path, existing.source.requested);
    applyGrantChanges(tool.command);
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
    // Captured once at adoption: the canonical legacy directory reused for
    // both the copy and the post-commit cleanup, so a settings change or a
    // raced symlink can never redirect either.
    let adoptedLegacyDir: string | undefined;
    if (!existing && ref === 'latest' && tool.legacyInstallDir) {
      const toolsRoot = readSettings().tools.rootFolder;
      // The segment itself must be a plain single name: path.join resolves
      // '..' (and '.') lexically, so resolved-path equality downstream
      // cannot catch either. '.' would adopt from and then recursively
      // delete the entire tools root.
      if (!isSafeLegacySegment(tool.legacyInstallDir))
        throw new Error(`Legacy install directory escapes the tools root: ${tool.legacyInstallDir}`);
      const segmentDir = path.join(toolsRoot, tool.legacyInstallDir);
      const candidateBinary = path.join(segmentDir, binName);
      // The catalog validates the segment; canonicalize before touching
      // anything so a symlinked segment (inside or outside the root) is
      // rejected instead of adopted or deleted.
      if (fs.existsSync(candidateBinary)) {
        const resolvedRoot = fs.realpathSync(toolsRoot);
        const resolvedDir = fs.realpathSync(segmentDir);
        if (resolvedDir !== path.join(resolvedRoot, tool.legacyInstallDir))
          throw new Error(`Legacy install directory escapes the tools root: ${tool.legacyInstallDir}`);
        adoptedLegacyDir = resolvedDir;
      }
      const legacyBinary = adoptedLegacyDir ? path.join(adoptedLegacyDir, binName) : candidateBinary;
      if (adoptedLegacyDir && fs.existsSync(legacyBinary) && !fs.lstatSync(legacyBinary).isSymbolicLink()) {
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
      if (tool.localDirectory) {
        planned = planLocalInstall(tool);
      } else {
        planned = await planPlatformsInstall({ ...tool, version: tool.version ?? pinnedVersion ?? '' });
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

    // Content-pinned descriptors trust the SHA-256, not runnability: never
    // launch the binary during install; the pinned descriptor version is
    // authoritative for every source.
    // The pinned descriptor version is authoritative; there is no
    // runnability gate and no below-minimum warning (the adoption gate
    // already enforces the descriptor minimum).
    const version = planned.version;

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

    ensureCommandShim(tool.command, record.path, record.source.requested);
    if (adopted) {
      // The adopted binary copied out of the legacy location; drop the empty
      // shell so nothing probes it as an unmanaged install anymore. Uses the
      // canonical path captured at adoption time, never a fresh lookup.
      const legacyDir = adoptedLegacyDir!;
      try {
        if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        logger.warn(`Adopted ${tool.command}, but legacy cleanup failed at ${legacyDir}; remove it manually.`);
      }
    }
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

// Re-exported for the legacy descriptor reader.
export { readNativeDescriptor };
