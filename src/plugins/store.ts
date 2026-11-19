import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { dataPath } from '../cfg/setting';
import { logger } from '../util/logger';
import { removeCommandShims } from './shims';
import {
  assertPluginCompatible,
  isPluginCommand,
  nativeBinaryFileName,
  PLUGIN_PERMISSIONS,
  PluginManifest,
  PluginMode,
  PluginPermission,
  readJsonFile,
  readPluginManifest,
} from './manifest';

export interface PluginSource {
  kind: 'npm' | 'github';
  requested: string;
  resolved: string;
}
/** A binary tool installation source: the first-party catalog or an approved GitHub repository. */
export interface NativeSource {
  kind: 'catalog' | 'github';
  /** Stable package identity without version: catalog name, or lowercase owner/repo. Drives approval, idempotency and command-change detection. */
  id: string;
  requested: string;
  resolved: string;
}
export interface NativeBinaryRecord {
  binName: string;
  version: string;
  /** Absolute path to the managed binary; stable across upgrades of the same command. */
  path: string;
  source: NativeSource;
}
export interface PluginInstallation {
  id: string;
  name: string;
  source: PluginSource;
  allowScripts: boolean;
}
export interface PluginLinkOptions {
  allow?: string[];
  read?: string[];
  trust?: boolean;
}
interface Registration {
  directory: string;
  permissions: PluginPermission[];
  readPaths: string[];
  /** Host authorization only; a package declaration can never select trusted execution. */
  trusted?: { name: string; version: string };
  installation?: PluginInstallation;
  /** Present exactly for binary tool plugins; mutually exclusive with installation/trusted. */
  binary?: NativeBinaryRecord;
  /** Explicit discriminator written by this version; absent means inferred from `binary`. */
  kind?: 'js' | 'binary';
}
interface Registry {
  apiVersion: 2;
  plugins: Record<string, Registration>;
}

export interface PluginInfo {
  command: string;
  directory: string;
  mode: PluginMode;
  kind: 'js' | 'binary';
  source?: PluginSource | NativeSource;
  state: 'available' | 'invalid' | 'incompatible' | 'shadowed';
  name?: string;
  version?: string;
  description?: string;
  error?: string;
  permissions?: PluginPermission[];
  readPaths?: string[];
}

export function pluginHome(): string {
  return path.resolve(process.env.OFFCKB_PLUGIN_HOME || path.join(dataPath, 'plugins'));
}

/** Package identity survives upgrades and command changes, but never transfers to another package. */
export function pluginStoragePaths(name: string): { data: string; cache: string } {
  const identity = createHash('sha256').update(name).digest('hex');
  return {
    data: path.join(pluginHome(), 'data', identity),
    cache: path.join(pluginHome(), 'cache', identity),
  };
}

function registryPath(): string {
  return path.join(pluginHome(), 'registry.json');
}

function readRegistry(): Registry {
  let value: unknown;
  try {
    value = readJsonFile(registryPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { apiVersion: 2, plugins: {} };
    throw new Error(`Cannot read plugin registry ${registryPath()}: ${(error as Error).message}`);
  }
  const legacy = value as { apiVersion?: number; plugins?: Record<string, unknown> };
  // Legacy links retain zero grants. Permission changes require an explicit relink.
  if (
    legacy?.apiVersion === 1 &&
    legacy.plugins &&
    typeof legacy.plugins === 'object' &&
    !Array.isArray(legacy.plugins)
  ) {
    value = {
      apiVersion: 2,
      plugins: Object.fromEntries(
        Object.entries(legacy.plugins).map(([command, directory]) => [
          command,
          { directory, permissions: [], readPaths: [] },
        ]),
      ),
    };
  }
  const registry = value as Registry;
  if (
    registry?.apiVersion !== 2 ||
    !registry.plugins ||
    typeof registry.plugins !== 'object' ||
    Array.isArray(registry.plugins) ||
    Object.entries(registry.plugins).some(
      ([command, entry]) =>
        !isPluginCommand(command) ||
        !entry ||
        typeof entry.directory !== 'string' ||
        !path.isAbsolute(entry.directory) ||
        !Array.isArray(entry.permissions) ||
        entry.permissions.some((permission) => !PLUGIN_PERMISSIONS.includes(permission)) ||
        !Array.isArray(entry.readPaths) ||
        entry.readPaths.some((file) => typeof file !== 'string' || !path.isAbsolute(file)) ||
        (entry.trusted !== undefined &&
          (!entry.trusted || typeof entry.trusted.name !== 'string' || typeof entry.trusted.version !== 'string')) ||
        (entry.installation !== undefined && !isInstallation(entry.installation)) ||
        (entry.binary !== undefined && !isNativeBinary(command, entry.binary)) ||
        (entry.binary !== undefined &&
          (entry.directory !== pluginNativeDir(command) ||
            path.basename(entry.binary.path) !== entry.binary.binName)) ||
        (entry.binary !== undefined &&
          (entry.installation !== undefined ||
            entry.trusted !== undefined ||
            entry.permissions.length !== 0 ||
            entry.readPaths.length !== 0)) ||
        (entry.kind !== undefined && (entry.kind === 'binary') !== (entry.binary !== undefined)),
    )
  )
    throw new Error(`Invalid plugin registry: ${registryPath()}`);
  return registry;
}

function isNativeBinary(command: string, value: NativeBinaryRecord): boolean {
  if (
    !value ||
    typeof value.binName !== 'string' ||
    !value.binName ||
    typeof value.version !== 'string' ||
    !value.version ||
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    // Reject non-canonical paths outright: no traversal, no redundant separators.
    path.normalize(value.path) !== value.path ||
    !value.source ||
    !['catalog', 'github'].includes(value.source.kind) ||
    typeof value.source.id !== 'string' ||
    !value.source.id ||
    typeof value.source.requested !== 'string' ||
    typeof value.source.resolved !== 'string'
  )
    return false;
  // The managed binary must live at exactly <plugin home>/native/<command>/<binName>,
  // never a sibling prefix (native/my-tool-evil/...), so the exposed path is
  // always host-owned and never a caller-supplied location.
  const nativeDir = path.join(pluginNativeRoot(), command);
  const inside = path.relative(pluginNativeRoot(), value.path);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return false;
  if (path.dirname(value.path) !== nativeDir) return false;
  // The directory that will hold the binary must not be a symlink: swap and
  // cleanup operate on real directories only.
  if (fs.existsSync(nativeDir) && fs.lstatSync(nativeDir).isSymbolicLink()) return false;
  return true;
}

function isInstallation(value: PluginInstallation): boolean {
  return (
    !!value &&
    /^[a-f0-9-]{36}$/.test(value.id) &&
    typeof value.name === 'string' &&
    typeof value.allowScripts === 'boolean' &&
    !!value.source &&
    ['npm', 'github'].includes(value.source.kind) &&
    typeof value.source.requested === 'string' &&
    typeof value.source.resolved === 'string'
  );
}

/** Store only an identifier; never recursively delete a caller-supplied installation path. */
export function pluginPackagesPath(): string {
  fs.mkdirSync(pluginHome(), { recursive: true, mode: 0o700 });
  const packages = path.join(fs.realpathSync(pluginHome()), 'packages');
  fs.mkdirSync(packages, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(packages).isSymbolicLink()) throw new Error('Plugin packages directory must not be a symlink');
  return packages;
}

/** Native tool plugins live under <plugin home>/native/<command>; the binary path is stable across upgrades. */
export function pluginNativeRoot(): string {
  return path.join(pluginHome(), 'native');
}

/** The native root must be a real directory inside the plugin home, never a symlink. */
export function assertNativeRootSafe(): void {
  const root = pluginNativeRoot();
  if (!fs.existsSync(root)) return;
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Plugin native tools root must not be a symlink: ${root}`);
  }
  // It must also resolve to the expected location inside the real plugin home
  // (the home itself may legitimately sit under a platform symlink such as
  // /var -> /private/var).
  const real = fs.realpathSync(root);
  if (path.basename(real) !== 'native' || path.dirname(real) !== fs.realpathSync(pluginHome())) {
    throw new Error(`Plugin native tools root resolves outside the plugin home: ${root}`);
  }
}

/** Non-throwing variant for discovery/execution paths, which fail closed instead. */
export function isNativeRootSafe(): boolean {
  try {
    assertNativeRootSafe();
    return true;
  } catch {
    return false;
  }
}

export function pluginNativeDir(command: string): string {
  if (!isPluginCommand(command)) throw new Error('Invalid plugin command');
  return path.join(pluginNativeRoot(), command);
}

function installationRoot(entry: Registration): string | undefined {
  if (!entry.installation) return;
  const root = path.join(pluginPackagesPath(), entry.installation.id);
  // A missing/corrupted managed package must remain removable, without following links.
  if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root))
    throw new Error('Managed plugin root must not be a symlink');
  const relative = path.relative(root, entry.directory);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    throw new Error('Managed plugin directory escapes its installation');
  return root;
}

function cleanupInstallation(root: string | undefined): void {
  if (!root) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    logger.warn(`Plugin registration updated, but package cleanup failed at ${root}; remove that directory manually.`);
  }
}

function withRegistryLock<T>(action: () => T): T {
  fs.mkdirSync(pluginHome(), { recursive: true, mode: 0o700 });
  const lock = path.join(pluginHome(), 'registry.lock');
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `Plugin registry is locked: ${lock}. If a writer crashed, remove this file after confirming it stopped.`,
    );
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return action();
  } finally {
    // Cleanup cannot turn a completed registry commit into a failed transaction, or mask
    // the original error. Attempt both operations even when closing the descriptor fails.
    try {
      fs.closeSync(fd);
    } catch {
      logger.warn(`Plugin registry lock close failed at ${lock}.`);
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      logger.warn(`Plugin registry lock cleanup failed at ${lock}; confirm the writer stopped before removing it.`);
    }
  }
}

function writeRegistry(registry: Registry, onCommit?: () => void): void {
  const temporary = `${registryPath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, registryPath());
    onCommit?.();
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      logger.warn(`Plugin registry temporary-file cleanup failed at ${temporary}.`);
    }
  }
}

function leasePath(command: string): string {
  if (!isPluginCommand(command)) throw new Error('Invalid plugin command');
  return path.join(pluginHome(), `${command}.running`);
}

function assertNotRunning(command: string): void {
  const file = leasePath(command);
  if (fs.existsSync(file)) {
    throw new Error(
      `${command} is running or has a stale run lock at ${file}. Stop it before unlinking/relinking; after a crash, confirm it stopped before removing the lock.`,
    );
  }
}

export function listPlugins(reserved: ReadonlySet<string>, checkMode?: (mode: PluginMode) => void): PluginInfo[] {
  return Object.entries(readRegistry().plugins).map(
    ([command, { directory, permissions, readPaths, trusted, installation, binary }]) => {
      const base = {
        command,
        directory,
        kind: (binary ? 'binary' : 'js') as 'binary' | 'js',
        // Binary tools always run natively; sandboxing is not offered for this kind.
        mode: binary || trusted ? ('trusted' as const) : ('sandbox' as const),
        ...(installation ? { source: installation.source } : {}),
        ...(binary ? { source: binary.source } : {}),
      };
      if (reserved.has(command)) return { ...base, state: 'shadowed', error: 'A core command has priority' };
      // Discovery fails closed: a tampered native root makes binary tools
      // unlisted rather than executable from outside the plugin home.
      if (binary && !isNativeRootSafe()) {
        return { ...base, state: 'invalid', error: 'Native tools root must not be a symlink' };
      }
      let plugin: PluginManifest;
      try {
        plugin = readPluginManifest(directory);
        if (plugin.command !== command) throw new Error('Plugin command changed; unlink and link the package again');
        assertPermissions(plugin, permissions);
        assertTrustedIdentity(plugin, trusted);
      } catch (error) {
        return { ...base, state: 'invalid', error: (error as Error).message };
      }
      const info = {
        ...base,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        permissions,
        readPaths,
      };
      try {
        assertPluginCompatible(plugin);
        checkMode?.(base.mode);
        return { ...info, state: 'available' };
      } catch (error) {
        return { ...info, state: 'incompatible', error: (error as Error).message };
      }
    },
  );
}

function assertPermissions(plugin: PluginManifest, granted: readonly string[]): void {
  if (plugin.permissions.some((permission) => !granted.includes(permission)))
    throw new Error(
      `${plugin.command} requires explicit grants: ${plugin.permissions.map((permission) => `--allow ${permission}`).join(' ')}. Relink or reinstall to approve changed permissions.`,
    );
}

function assertTrustedIdentity(plugin: PluginManifest, trusted: Registration['trusted']): void {
  if (trusted && (trusted.name !== plugin.name || trusted.version !== plugin.version))
    throw new Error(`${plugin.command} package identity changed; relink with --trust to trust this name/version`);
}

export function linkPlugin(
  directory: string,
  reserved: ReadonlySet<string>,
  options: PluginLinkOptions = {},
): PluginManifest {
  return withRegistryLock(() => {
    const plugin = readPluginManifest(directory);
    // Binary tools are registered only by the native installer, which enforces
    // the trusted-source allowlist; a local link must never bypass it.
    if (plugin.kind !== 'js') {
      throw new Error('Binary tool plugins are installed with: offckb plugin install <catalog-name|github:owner/repo>');
    }
    assertPluginCompatible(plugin);
    assertPermissions(plugin, options.allow ?? []);
    if (options.allow?.some((permission) => !plugin.permissions.includes(permission as PluginPermission)))
      throw new Error('Only permissions declared by this plugin may be granted');
    const readPaths = (options.read ?? []).map((file) => fs.realpathSync(file));
    if (reserved.has(plugin.command)) throw new Error(`Plugin command ${plugin.command} conflicts with a core command`);
    const registry = readRegistry();
    const existing = Object.prototype.hasOwnProperty.call(registry.plugins, plugin.command)
      ? registry.plugins[plugin.command]
      : undefined;
    if (existing && existing.directory !== plugin.directory)
      throw new Error(`Plugin command ${plugin.command} is already linked`);
    assertNotRunning(plugin.command);
    registry.plugins[plugin.command] = {
      directory: plugin.directory,
      permissions: plugin.permissions,
      readPaths,
      ...(options.trust ? { trusted: { name: plugin.name, version: plugin.version } } : {}),
      ...(existing?.installation ? { installation: existing.installation } : {}),
    };
    writeRegistry(registry);
    return plugin;
  });
}

export function unlinkPlugin(command: string): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    assertNotRunning(command);
    if (!Object.prototype.hasOwnProperty.call(registry.plugins, command))
      throw new Error(`Plugin ${command} is not linked`);
    if (registry.plugins[command].installation) throw new Error('Use plugin remove to uninstall a managed package');
    if (registry.plugins[command].binary)
      throw new Error('Use plugin remove to uninstall a binary tool; it also cleans the managed binary and shims');
    delete registry.plugins[command];
    writeRegistry(registry);
  });
}

export function commitPluginInstallation(
  directory: string,
  installation: PluginInstallation,
  reserved: ReadonlySet<string>,
  options: PluginLinkOptions,
  onCommit?: () => void,
): PluginManifest {
  let previousRoot: string | undefined;
  const plugin = withRegistryLock(() => {
    const candidate = readPluginManifest(directory);
    // The npm install path only registers JS plugins; binary descriptors are
    // handled by the native installer with its trusted-source allowlist.
    if (candidate.kind !== 'js') {
      throw new Error(
        'Installed package declares a binary tool descriptor; install it as a binary tool source instead',
      );
    }
    assertPluginCompatible(candidate);
    assertPermissions(candidate, options.allow ?? []);
    if (options.allow?.some((permission) => !candidate.permissions.includes(permission as PluginPermission)))
      throw new Error('Only permissions declared by this plugin may be granted');
    if (!isInstallation(installation) || installation.name !== candidate.name) throw new Error('Invalid installation');
    if (reserved.has(candidate.command))
      throw new Error(`Plugin command ${candidate.command} conflicts with a core command`);
    const registry = readRegistry();
    const previous = Object.prototype.hasOwnProperty.call(registry.plugins, candidate.command)
      ? registry.plugins[candidate.command]
      : undefined;
    if (previous && (!previous.installation || previous.installation.name !== candidate.name))
      throw new Error(`Plugin command ${candidate.command} is already linked; remove/unlink it explicitly first`);
    if (
      Object.entries(registry.plugins).some(
        ([name, entry]) => name !== candidate.command && entry.installation?.name === candidate.name,
      )
    )
      throw new Error('This package changed its command; remove its previous registration first');
    assertNotRunning(candidate.command);
    if (previous) previousRoot = installationRoot(previous);
    const entry: Registration = {
      directory: candidate.directory,
      permissions: candidate.permissions,
      readPaths: (options.read ?? []).map((file) => fs.realpathSync(file)),
      ...(options.trust ? { trusted: { name: candidate.name, version: candidate.version } } : {}),
      installation,
    };
    if (installationRoot(entry) === previousRoot)
      throw new Error('A replacement must use a fresh installation directory');
    registry.plugins[candidate.command] = entry;
    // Ownership transfers at rename, before any lock or old-package cleanup can fail.
    writeRegistry(registry, onCommit);
    return candidate;
  });
  cleanupInstallation(previousRoot);
  return plugin;
}

/** Managed packages are removed; user-linked directories and persistent data/cache are kept. */
export function removePlugin(command: string): void {
  let root: string | undefined;
  let nativeDir: string | undefined;
  withRegistryLock(() => {
    const registry = readRegistry();
    if (!Object.prototype.hasOwnProperty.call(registry.plugins, command))
      throw new Error(`Plugin ${command} is not linked`);
    assertNotRunning(command);
    root = installationRoot(registry.plugins[command]);
    if (registry.plugins[command].binary) {
      const dir = pluginNativeDir(command);
      // Only ever delete a host-owned directory under the native tools root.
      const relative = path.relative(pluginNativeRoot(), dir);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) nativeDir = dir;
      // Verify before the registry write: a symlinked native root must leave
      // the registration, the binary and the shims completely untouched.
      assertNativeRootSafe();
    }
    delete registry.plugins[command];
    writeRegistry(registry);
  });
  cleanupInstallation(root);
  if (nativeDir) {
    try {
      fs.rmSync(nativeDir, { recursive: true, force: true });
    } catch {
      logger.warn(`Plugin registration removed, but native tool cleanup failed at ${nativeDir}; remove it manually.`);
    }
    removeCommandShims(command);
  }
}

/**
 * Binary tool registrations are trusted natively; catalog/GitHub source is recorded for display.
 * `swapIntoPlace` runs inside the registry lock, before the registry write, so a failed swap
 * (e.g. the old binary still running on Windows) never leaves a committed-but-missing tool.
 * `rollbackSwap` restores the previous on-disk state when the registry write itself fails.
 */
export function commitNativeRegistration(
  command: string,
  record: NativeBinaryRecord,
  reserved: ReadonlySet<string>,
  swapIntoPlace: () => void,
  rollbackSwap: () => void,
): void {
  withRegistryLock(() => {
    if (!isPluginCommand(command)) throw new Error('Invalid plugin command');
    if (reserved.has(command)) throw new Error(`Plugin command ${command} conflicts with a core command`);
    const registry = readRegistry();
    const previous = Object.prototype.hasOwnProperty.call(registry.plugins, command)
      ? registry.plugins[command]
      : undefined;
    if (previous && !previous.binary)
      throw new Error(`Plugin command ${command} is already linked; remove/unlink it explicitly first`);
    // Compare stable package identity (without version), matching the JS
    // installation check: one package must not claim two commands, even when
    // the new command has no registration yet.
    if (
      Object.entries(registry.plugins).some(
        ([name, entry]) => name !== command && entry.binary?.source.id === record.source.id,
      )
    )
      throw new Error('This tool changed its command; remove its previous registration first');
    assertNotRunning(command);
    // The target directory must be a real directory, never a symlink:
    // swap and cleanup operate on host-owned paths only.
    assertNativeRootSafe();
    const nativeDir = pluginNativeDir(command);
    if (fs.existsSync(nativeDir) && fs.lstatSync(nativeDir).isSymbolicLink()) {
      throw new Error(`Managed tool directory must not be a symlink: ${nativeDir}`);
    }
    swapIntoPlace();
    registry.plugins[command] = {
      directory: pluginNativeDir(command),
      permissions: [],
      readPaths: [],
      binary: record,
      kind: 'binary',
    };
    try {
      writeRegistry(registry);
    } catch (error) {
      // The on-disk tool already moved; put the previous directory back so
      // paths and contents agree with the untouched registration.
      try {
        rollbackSwap();
      } catch (rollbackError) {
        logger.warn(`Registry write failed and the swap rollback also failed: ${(rollbackError as Error).message}`);
      }
      throw error;
    }
  });
}

/** Resolve a registered native tool's binary path, or null when absent/uninstalled. Never throws. */
export function getNativeBinaryPath(command: string): string | null {
  if (!isNativeRootSafe()) return null;
  return getNativeRecord(command)?.path ?? null;
}

/** The raw native registration record, or null. Never throws. */
export function getNativeRecord(command: string): NativeBinaryRecord | null {
  try {
    const registry = readRegistry();
    const entry = Object.prototype.hasOwnProperty.call(registry.plugins, command)
      ? registry.plugins[command]
      : undefined;
    if (!entry?.binary || !fs.existsSync(entry.binary.path)) return null;
    return entry.binary;
  } catch {
    return null;
  }
}

export interface NativeToolEnvEntry {
  command: string;
  envName: string;
  path: string;
}

/** OFFCKB_TOOL_<COMMAND> entries for every registered native tool, for env export and child processes. */
export function listNativeTools(): NativeToolEnvEntry[] {
  if (!isNativeRootSafe()) return [];
  try {
    return Object.entries(readRegistry().plugins).flatMap(([command, entry]) => {
      if (!entry.binary || !fs.existsSync(entry.binary.path)) return [];
      return [
        {
          command,
          envName: `OFFCKB_TOOL_${command.toUpperCase().replace(/-/g, '_')}`,
          path: entry.binary.path,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function nativeToolEnv(): Record<string, string> {
  return Object.fromEntries(listNativeTools().map((tool) => [tool.envName, tool.path]));
}

// --- Trusted-source allowlist for third-party binary tools ---
// The catalog is implicitly trusted; anything else must be approved locally
// first. Approval binds the source identity (owner/repo, or npm package or
// scope), never a version: installs stay pinned per install, and upgrading
// from an approved source never re-prompts.

const TRUSTED_SOURCES_FILE = 'trusted-sources.json';

interface TrustedSourcesFile {
  apiVersion: 1;
  sources: Array<{ source: string; addedAt: string }>;
}

function trustedSourcesPath(): string {
  return path.join(pluginHome(), TRUSTED_SOURCES_FILE);
}

export function normalizeTrustedSource(source: string): string {
  const trimmed = source.trim();
  // Identities are case-insensitive on both GitHub and the npm registry;
  // the normalized form is the lowercase spelling.
  const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
  const githubRepo = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;
  if (!npmName.test(trimmed) && !githubRepo.test(trimmed)) {
    throw new Error('Invalid trusted source: use a GitHub owner/repo or an npm package/scope name');
  }
  return trimmed.toLowerCase();
}

function readTrustedSources(): TrustedSourcesFile {
  let value: unknown;
  try {
    value = readJsonFile(trustedSourcesPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { apiVersion: 1, sources: [] };
    throw new Error(`Cannot read trusted sources ${trustedSourcesPath()}: ${(error as Error).message}`);
  }
  const file = value as TrustedSourcesFile;
  if (
    file?.apiVersion !== 1 ||
    !Array.isArray(file.sources) ||
    file.sources.some((entry) => !entry || typeof entry.source !== 'string' || typeof entry.addedAt !== 'string')
  )
    throw new Error(`Invalid trusted sources file: ${trustedSourcesPath()}`);
  return file;
}

function writeTrustedSources(file: TrustedSourcesFile): void {
  const temporary = `${trustedSourcesPath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, trustedSourcesPath());
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      logger.warn(`Trusted sources temporary-file cleanup failed at ${temporary}.`);
    }
  }
}

export function listTrustedSources(): string[] {
  return readTrustedSources().sources.map((entry) => entry.source);
}

export function isSourceTrusted(source: string): boolean {
  const normalized = normalizeTrustedSource(source);
  return listTrustedSources().includes(normalized);
}

export function addTrustedSource(source: string): string[] {
  const normalized = normalizeTrustedSource(source);
  return withRegistryLock(() => {
    const file = readTrustedSources();
    if (!file.sources.some((entry) => entry.source === normalized)) {
      file.sources.push({ source: normalized, addedAt: new Date().toISOString() });
      writeTrustedSources(file);
    }
    return file.sources.map((entry) => entry.source);
  });
}

/** Removing a source freezes its existing installs in place; upgrades/reinstalls require re-approval. */
export function removeTrustedSource(source: string): string[] {
  const normalized = normalizeTrustedSource(source);
  return withRegistryLock(() => {
    const file = readTrustedSources();
    file.sources = file.sources.filter((entry) => entry.source !== normalized);
    writeTrustedSources(file);
    return file.sources.map((entry) => entry.source);
  });
}

/** A foreground lease prevents unlink/relink; it never authorizes signaling a saved PID. */
export function acquirePlugin(
  command: string,
  checkMode?: (mode: PluginMode) => void,
): { plugin: PluginManifest; mode: PluginMode; readPaths: string[]; release: () => void } {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const entry = Object.prototype.hasOwnProperty.call(registry.plugins, command)
      ? registry.plugins[command]
      : undefined;
    if (!entry) throw new Error(`Plugin ${command} is no longer linked`);
    // Execution fails closed: a tampered native root never runs a managed
    // binary from outside the plugin home.
    if (entry.binary && !isNativeRootSafe()) {
      throw new Error('Native tools root must not be a symlink; refusing to run the managed binary');
    }
    const plugin = readPluginManifest(entry.directory);
    if (plugin.command !== command) throw new Error('Plugin command changed; unlink and link the package again');
    // The registration shape and the on-disk declaration must agree, so a
    // swapped descriptor can never change how a registration executes.
    if (Boolean(entry.binary) !== (plugin.kind === 'binary')) {
      throw new Error('Plugin registration kind changed; remove and reinstall the tool');
    }
    if (entry.binary && nativeBinaryFileName(plugin.binaryName!) !== path.basename(entry.binary.path)) {
      throw new Error('Managed binary identity changed; remove and reinstall the tool');
    }
    assertPluginCompatible(plugin);
    assertPermissions(plugin, entry.permissions);
    assertTrustedIdentity(plugin, entry.trusted);
    // Binary tools always run natively with the user's permissions; only JS
    // plugins can be sandboxed. A binary tool must never be refused because
    // the sandbox runtime is unavailable (e.g. Windows / older Node).
    const mode = entry.binary || entry.trusted ? 'trusted' : 'sandbox';
    checkMode?.(mode);
    assertNotRunning(command);
    const file = leasePath(command);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    return { plugin, mode, readPaths: entry.readPaths, release: () => fs.rmSync(file, { force: true }) };
  });
}
