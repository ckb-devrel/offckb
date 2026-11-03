import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { dataPath } from '../cfg/setting';
import { logger } from '../util/logger';
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
  kind: 'npm' | 'github';
  requested: string;
  resolved: string;
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
}
interface Registry {
  apiVersion: 2;
  plugins: Record<string, Registration>;
}

export interface PluginInfo {
  command: string;
  directory: string;
  mode: PluginMode;
  source?: PluginSource;
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
        (entry.installation !== undefined && !isInstallation(entry.installation)),
    )
  )
    throw new Error(`Invalid plugin registry: ${registryPath()}`);
  return registry;
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
    ([command, { directory, permissions, readPaths, trusted, installation }]) => {
      const base = {
        command,
        directory,
        mode: trusted ? ('trusted' as const) : ('sandbox' as const),
        ...(installation ? { source: installation.source } : {}),
      };
      if (reserved.has(command)) return { ...base, state: 'shadowed', error: 'A core command has priority' };
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
  withRegistryLock(() => {
    const registry = readRegistry();
    if (!Object.prototype.hasOwnProperty.call(registry.plugins, command))
      throw new Error(`Plugin ${command} is not linked`);
    assertNotRunning(command);
    root = installationRoot(registry.plugins[command]);
    delete registry.plugins[command];
    writeRegistry(registry);
  });
  cleanupInstallation(root);
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
    const plugin = readPluginManifest(entry.directory);
    if (plugin.command !== command) throw new Error('Plugin command changed; unlink and link the package again');
    assertPluginCompatible(plugin);
    assertPermissions(plugin, entry.permissions);
    assertTrustedIdentity(plugin, entry.trusted);
    const mode = entry.trusted ? 'trusted' : 'sandbox';
    checkMode?.(mode);
    assertNotRunning(command);
    const file = leasePath(command);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    return { plugin, mode, readPaths: entry.readPaths, release: () => fs.rmSync(file, { force: true }) };
  });
}
