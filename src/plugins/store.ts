import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { dataPath } from '../cfg/setting';
import { logger } from '../util/logger';
import { removeCommandShims } from './shims';
import {
  assertPluginCompatible,
  isPluginCommand,
  PLUGIN_PERMISSIONS,
  PluginManifest,
  PluginMode,
  PluginPermission,
  readJsonFile,
  readPluginManifest,
} from './manifest';

export interface PluginSource {
  kind: 'npm' | 'github' | 'binary';
  requested: string;
  resolved: string;
  /** Credential-free directory of npm's locked package URL; absent in older registrations. */
  packageLocation?: string;
}
export interface PluginPermissionReview {
  installationId: string;
  permissions: PluginPermission[];
  source: PluginSource;
}
export interface PluginRegistrationOptions extends PluginLinkOptions {
  permissionReview?: PluginPermissionReview;
}
/** A binary tool installation source. */
export interface NativeSource {
  kind: 'catalog' | 'github' | 'bundled' | 'descriptor';
  /** Stable package identity without version: catalog name, lowercase owner/repo, tool:<name>, or descriptor name. Drives approval, idempotency and command-change detection. */
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
            entry.readPaths.length !== 0 ||
            entry.permissions.some((permission) => !PLUGIN_PERMISSIONS.includes(permission)))) ||
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
    !['catalog', 'github', 'bundled', 'descriptor'].includes(value.source.kind) ||
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
    ['npm', 'github', 'binary'].includes(value.source.kind) &&
    typeof value.source.requested === 'string' &&
    typeof value.source.resolved === 'string' &&
    (value.source.packageLocation === undefined || typeof value.source.packageLocation === 'string')
  );
}

function samePermissionSource(first: PluginSource, second: PluginSource): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'npm') return !!first.packageLocation && first.packageLocation === second.packageLocation;
  if (first.kind !== 'github') return false;
  const repository = (source: PluginSource) =>
    /^github:([a-z0-9-]+\/[a-z0-9._-]+)#[a-f0-9]{40}$/i.exec(source.resolved)?.[1].toLowerCase();
  const previous = repository(first);
  return !!previous && previous === repository(second);
}

/** Reuse only an existing managed package's grants, never another package's or source's. */
export function reviewPluginPermissions(
  plugin: PluginManifest,
  source: PluginSource,
): PluginPermissionReview | undefined {
  const previous = readRegistry().plugins[plugin.command];
  if (
    !previous?.installation ||
    previous.installation.name !== plugin.name ||
    !samePermissionSource(previous.installation.source, source)
  )
    return;
  return {
    installationId: previous.installation.id,
    permissions: [...previous.permissions],
    source: previous.installation.source,
  };
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

/** A managed binary must be a regular file; a swapped-in symlink fails closed. */
function isUsableManagedBinary(binaryPath: string): boolean {
  try {
    const stats = fs.lstatSync(binaryPath);
    return stats.isFile() && !stats.isSymbolicLink();
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

/** Create the plugin home with an actionable error when it cannot be a directory. */
export function ensurePluginHome(): string {
  const home = pluginHome();
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(
      `Cannot create the plugin home at ${home}: ${(error as NodeJS.ErrnoException).code || (error as Error).message}. ` +
        'Check that OFFCKB_PLUGIN_HOME (or the offckb data directory) is not occupied by a file.',
    );
  }
  return home;
}

function withRegistryLock<T>(action: () => T): T {
  ensurePluginHome();
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
        // Binary tools always run natively; JS plugins run sandboxed unless trusted.
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
        // The registry and the on-disk manifest must agree on the kind: a
        // linked JS directory swapped for a binary descriptor (or a managed
        // binary swapped for a JS package) is invalid here, not a sandbox
        // error at run time.
        if ((binary ? 'binary' : 'js') !== plugin.kind) throw new Error(registrationKindChangedMessage);
        assertPermissions(plugin, permissions);
        assertTrustedIdentity(plugin, trusted);
      } catch (error) {
        return { ...base, state: 'invalid', error: (error as Error).message };
      }
      const info = {
        ...base,
        // The manifest is authoritative: linked binary tools have no managed
        // record but are still binary kind.
        kind: plugin.kind,
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
    // Linking is the JavaScript plugin development flow: it references the
    // user's directory in place. Binary tools take the other verb — a
    // managed copy via `offckb plugin install ./dir` — because their
    // contract is the file itself, not live edits.
    if (plugin.kind === 'binary')
      throw new Error(
        `${directory} declares a binary tool; install a managed copy instead: offckb plugin install ${directory}`,
      );
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
  options: PluginRegistrationOptions,
  onCommit?: () => void,
): PluginManifest {
  let previousRoot: string | undefined;
  const plugin = withRegistryLock(() => {
    const candidate = readPluginManifest(directory);
    // The npm install path only registers JS plugins; binary tools come from
    // the catalog or a local directory install.
    if (candidate.kind !== 'js') {
      throw new Error(
        'Installed package declares a binary tool descriptor; install it from the catalog or a local directory instead',
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
    const review = options.permissionReview;
    if (
      review &&
      (!previous?.installation ||
        previous.installation.id !== review.installationId ||
        !samePermissionSource(previous.installation.source, review.source) ||
        [...previous.permissions].sort().join(',') !== [...review.permissions].sort().join(','))
    )
      throw new Error('Plugin authorization changed during installation; retry to review the current grants');
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
 * Legacy bundled-tool registrations recorded ids as `tool:<name>`; the
 * unified catalog identifies a tool by its descriptor name. Comparing
 * normalized ids lets pre-merge installs upgrade through the catalog
 * instead of tripping the ownership guard.
 */
function normalizeSourceId(id: string): string {
  return id.startsWith('tool:') ? id.slice('tool:'.length) : id;
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
  permissions: PluginPermission[],
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
    // Command ownership binds to the source identity of the first install.
    // A different identity (e.g. a local descriptor reusing the command of a
    // catalog tool) must be explicit: swap-in from a new owner would silently
    // retarget every consumer of this command.
    if (previous?.binary && normalizeSourceId(previous.binary.source.id) !== normalizeSourceId(record.source.id))
      throw new Error(
        `Plugin command ${command} is already owned by source "${previous.binary.source.id}"; ` +
          `remove it first with: offckb plugin remove ${command}`,
      );
    // Compare stable package identity (without version), matching the JS
    // installation check: one package must not claim two commands, even when
    // the new command has no registration yet.
    if (
      Object.entries(registry.plugins).some(
        ([name, entry]) =>
          name !== command &&
          entry.binary !== undefined &&
          normalizeSourceId(entry.binary.source.id) === normalizeSourceId(record.source.id),
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
      permissions: [...permissions].sort(),
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

/** Update capability grants on an installed native tool (e.g. a same-version reinstall with different --allow flags). */
export function updateNativeGrants(command: string, permissions: PluginPermission[]): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entry = Object.prototype.hasOwnProperty.call(registry.plugins, command)
      ? registry.plugins[command]
      : undefined;
    if (!entry?.binary) throw new Error(`No installed binary tool named ${command}`);
    assertNotRunning(command);
    const plugin = readPluginManifest(entry.directory);
    if (plugin.kind !== 'binary') throw new Error('Plugin registration kind changed; remove and reinstall the tool');
    if (permissions.some((permission) => !plugin.permissions.includes(permission)))
      throw new Error('Only permissions declared by this tool may be granted');
    entry.permissions = [...permissions].sort();
    writeRegistry(registry);
  });
}

/** Resolve a registered native tool's binary path, or null when absent/uninstalled. Never throws. */
export function getNativeBinaryPath(command: string): string | null {
  if (!isNativeRootSafe()) return null;
  return getNativeRecord(command)?.path ?? null;
}

/** The raw native registration record, or null. Never throws. */
export function getNativeRecord(command: string): NativeBinaryRecord | null {
  return getNativeRegistration(command)?.binary ?? null;
}

/** Registration record plus granted capabilities, or null. Never throws. */
export function getNativeRegistration(
  command: string,
): { binary: NativeBinaryRecord; permissions: PluginPermission[] } | null {
  try {
    const registry = readRegistry();
    const entry = Object.prototype.hasOwnProperty.call(registry.plugins, command)
      ? registry.plugins[command]
      : undefined;
    if (!entry?.binary || !isUsableManagedBinary(entry.binary.path)) return null;
    return { binary: entry.binary, permissions: entry.permissions };
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
      if (!entry.binary || !isUsableManagedBinary(entry.binary.path)) return [];
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

/** A foreground lease prevents unlink/relink; it never authorizes signaling a saved PID. */
/** One message for every registry-vs-manifest kind mismatch, from list and from acquire. */
export const registrationKindChangedMessage =
  'Plugin registration kind changed; remove and reinstall the tool: offckb plugin remove <command>, then install or link it again';

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
    // A managed native registration and the on-disk declaration must agree,
    // so a swapped descriptor can never retarget where the host runs a
    // managed binary from. Linked directories follow the normal link rules.
    // A registration whose on-disk manifest changed kind (managed binary
    // swapped for JS, or a linked JS directory swapped for a binary
    // descriptor) is never silently re-interpreted: binary tools are managed
    // copies, JS plugins are the only sandboxed kind. One shared message.
    if ((entry.binary ? 'binary' : 'js') !== plugin.kind) throw new Error(registrationKindChangedMessage);
    if (entry.binary && fs.realpathSync(plugin.entry!) !== fs.realpathSync(entry.binary.path)) {
      throw new Error('Managed binary identity changed; remove and reinstall the tool');
    }
    assertPluginCompatible(plugin);
    assertPermissions(plugin, entry.permissions);
    assertTrustedIdentity(plugin, entry.trusted);
    // Binary tools always run natively with the user's permissions: their
    // primary channel is direct spawn, which no host sandbox can cover, so
    // the host-delegated run matches reality. Declared permissions still
    // gate host-provided interfaces (e.g. the read-RPC URL binding).
    const mode = entry.binary || entry.trusted ? 'trusted' : 'sandbox';
    checkMode?.(mode);
    assertNotRunning(command);
    const file = leasePath(command);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    return { plugin, mode, readPaths: entry.readPaths, release: () => fs.rmSync(file, { force: true }) };
  });
}
