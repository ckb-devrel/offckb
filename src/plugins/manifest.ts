import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { parseToolDescriptor, ToolExecution } from './tool-descriptor';

export const PLUGIN_PERMISSIONS = ['devnet-read', 'project-deployment', 'serve'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginMode = 'sandbox' | 'trusted';

export interface PluginManifest {
  directory: string;
  name: string;
  version: string;
  command: string;
  description: string;
  entry: string;
  node?: string;
  permissions: PluginPermission[];
  runtime?: 'binary';
  execution?: ToolExecution;
}

export function isPluginCommand(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}

export function readJsonFile(file: string): unknown {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Expected a JSON file under 1 MiB: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readPluginManifest(directory: string): PluginManifest {
  const root = fs.realpathSync(directory);
  const toolFile = path.join(root, 'offckb-tool.json');
  if (fs.existsSync(toolFile)) {
    const tool = parseToolDescriptor(readJsonFile(toolFile));
    const entry = fs.realpathSync(path.resolve(root, tool.entry));
    const relative = path.relative(root, entry);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
      throw new Error('Binary entry must stay inside the plugin directory');
    if (!fs.statSync(entry).isFile()) throw new Error('Binary entry must be a regular file');
    if (process.platform === 'win32' && !entry.toLowerCase().endsWith('.exe'))
      throw new Error('Windows binary entries must be .exe files');
    fs.accessSync(entry, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return {
      directory: root,
      name: tool.name,
      version: tool.version,
      command: tool.command,
      description: tool.description,
      entry,
      runtime: 'binary',
      execution: tool.execution,
      permissions: tool.permissions,
    };
  }
  const pkg = readJsonFile(path.join(root, 'package.json')) as Record<string, unknown>;
  const declaration = pkg?.offckb as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg.name !== 'string' || !pkg.name.trim() || !semver.valid(String(pkg.version))) {
    throw new Error(`Invalid plugin package identity: ${root}`);
  }
  if (declaration?.apiVersion !== 1 || !isPluginCommand(declaration.command)) {
    throw new Error(`Expected offckb.apiVersion 1 and a simple offckb.command in ${root}/package.json`);
  }
  if (typeof declaration.entry !== 'string' || path.isAbsolute(declaration.entry)) {
    throw new Error('offckb.entry must be a relative JavaScript file');
  }
  const entry = fs.realpathSync(path.resolve(root, declaration.entry));
  const relative = path.relative(root, entry);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('offckb.entry must stay inside the plugin package');
  }
  if (!fs.statSync(entry).isFile() || !/\.(?:cjs|mjs|js)$/.test(entry)) {
    throw new Error('offckb.entry must be a regular, prebuilt .js, .cjs or .mjs file');
  }
  const engines = pkg.engines as Record<string, unknown> | undefined;
  const node = engines?.node;
  if (node !== undefined && (typeof node !== 'string' || !semver.validRange(node))) {
    throw new Error('Invalid plugin engines.node range');
  }
  const permissions = declaration.permissions ?? [];
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => !PLUGIN_PERMISSIONS.includes(permission)) ||
    new Set(permissions).size !== permissions.length
  )
    throw new Error(`offckb.permissions must contain only: ${PLUGIN_PERMISSIONS.join(', ')}`);
  return {
    directory: root,
    name: pkg.name,
    version: String(pkg.version),
    command: declaration.command,
    entry,
    description: typeof declaration.description === 'string' ? declaration.description : pkg.name,
    permissions: [...permissions].sort(),
    ...(typeof node === 'string' ? { node } : {}),
  };
}

export function assertPluginCompatible(plugin: PluginManifest): void {
  if (plugin.node && !semver.satisfies(process.versions.node, plugin.node)) {
    throw new Error(`${plugin.command} requires Node ${plugin.node}; running ${process.versions.node}`);
  }
}
