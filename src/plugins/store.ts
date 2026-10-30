import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { dataPath } from '../cfg/setting';
import {
  assertPluginCompatible,
  isPluginCommand,
  PLUGIN_PERMISSIONS,
  PluginManifest,
  PluginPermission,
  readJsonFile,
  readPluginManifest,
} from './manifest';

interface Registration {
  directory: string;
  permissions: PluginPermission[];
  readPaths: string[];
}
interface Registry {
  apiVersion: 2;
  plugins: Record<string, Registration>;
}

export interface PluginInfo {
  command: string;
  directory: string;
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
        entry.readPaths.some((file) => typeof file !== 'string' || !path.isAbsolute(file)),
    )
  )
    throw new Error(`Invalid plugin registry: ${registryPath()}`);
  return registry;
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
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function writeRegistry(registry: Registry): void {
  const temporary = `${registryPath()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, registryPath());
  } finally {
    fs.rmSync(temporary, { force: true });
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

export function listPlugins(reserved: ReadonlySet<string>): PluginInfo[] {
  return Object.entries(readRegistry().plugins).map(([command, { directory, permissions, readPaths }]) => {
    const base = { command, directory };
    if (reserved.has(command)) return { ...base, state: 'shadowed', error: 'A core command has priority' };
    let plugin: PluginManifest;
    try {
      plugin = readPluginManifest(directory);
      if (plugin.command !== command) throw new Error('Plugin command changed; unlink and link the package again');
      assertPermissions(plugin, permissions);
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
      return { ...info, state: 'available' };
    } catch (error) {
      return { ...info, state: 'incompatible', error: (error as Error).message };
    }
  });
}

function assertPermissions(plugin: PluginManifest, granted: readonly string[]): void {
  if (plugin.permissions.some((permission) => !granted.includes(permission)))
    throw new Error(
      `${plugin.command} requires explicit grants: ${plugin.permissions.map((permission) => `--allow ${permission}`).join(' ')}. Relink to approve changed permissions.`,
    );
}

export function linkPlugin(
  directory: string,
  reserved: ReadonlySet<string>,
  options: { allow?: string[]; read?: string[] } = {},
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
    registry.plugins[plugin.command] = { directory: plugin.directory, permissions: plugin.permissions, readPaths };
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
    delete registry.plugins[command];
    writeRegistry(registry);
  });
}

/** A foreground lease prevents unlink/relink; it never authorizes signaling a saved PID. */
export function acquirePlugin(command: string): { plugin: PluginManifest; readPaths: string[]; release: () => void } {
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
    assertNotRunning(command);
    const file = leasePath(command);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    return { plugin, readPaths: entry.readPaths, release: () => fs.rmSync(file, { force: true }) };
  });
}
