import path from 'path';
import semver from 'semver';
import { isPluginCommand, PLUGIN_PERMISSIONS, PluginPermission } from './manifest';

export interface ToolExecution {
  args: string[];
  env: Record<string, string>;
}
export interface ToolAsset {
  url: string;
  sha256: string;
  format: 'raw' | 'zip' | 'tar.gz';
  executable: string;
}
export interface ToolDescriptor {
  apiVersion: 1;
  name: string;
  version: string;
  command: string;
  description: string;
  entry: string;
  permissions: PluginPermission[];
  execution: ToolExecution;
  platforms?: Record<string, ToolAsset>;
}

export function safeToolPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 512 &&
    !/[\\:<>"|?*\x00-\x1f\x7f]/.test(value) &&
    !path.posix.isAbsolute(value) &&
    value
      .split('/')
      .every((part) => !!part && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  );
}

export function toolUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error('Tool downloads require credential-free HTTPS URLs without query or fragment');
  return url;
}

const BINDINGS = new Set(['devnet.rpcUrl', 'plugin.dataPath', 'plugin.cachePath', 'cwd']);
function template(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) return false;
  return !value.replace(/\$\{([^}]+)\}/g, (_match, key) => (BINDINGS.has(key) ? '' : '${invalid}')).includes('${');
}

/** Static data only: no scripts, shell expressions, secret imports or implicit grants. */
export function parseToolDescriptor(value: unknown, requireAssets = false): ToolDescriptor {
  const tool = value as ToolDescriptor;
  if (
    !tool ||
    tool.apiVersion !== 1 ||
    !isPluginCommand(tool.command) ||
    !safeToolPath(tool.command) ||
    typeof tool.name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(tool.name) ||
    tool.name.length > 214 ||
    typeof tool.version !== 'string' ||
    !semver.valid(tool.version) ||
    !safeToolPath(tool.entry) ||
    typeof tool.description !== 'string' ||
    tool.description.length > 1024
  )
    throw new Error('Invalid binary tool identity, version, command or entry');
  if (
    !Array.isArray(tool.permissions) ||
    tool.permissions.some((p) => !PLUGIN_PERMISSIONS.includes(p)) ||
    new Set(tool.permissions).size !== tool.permissions.length
  )
    throw new Error('Invalid binary tool permissions');
  const execution = tool.execution ?? { args: [], env: {} };
  if (
    !Array.isArray(execution.args) ||
    execution.args.length > 128 ||
    !execution.args.every(template) ||
    !execution.env ||
    typeof execution.env !== 'object' ||
    Array.isArray(execution.env) ||
    Object.keys(execution.env).length > 32 ||
    Object.entries(execution.env).some(
      ([key, val]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        /^(PATH|HOME|TMP.*|TEMP|NODE.*|LD_.*|DYLD_.*|OFFCKB_.*|CLAUDE_.*|.*PROXY.*)$/.test(key) ||
        !template(val),
    )
  )
    throw new Error('Invalid binary tool arguments or environment bindings');
  if (
    !tool.permissions.includes('devnet-read') &&
    [...execution.args, ...Object.values(execution.env)].some((value) => value.includes('${devnet.rpcUrl}'))
  )
    throw new Error('RPC binding requires the declared devnet-read permission');
  if (requireAssets && (!tool.platforms || !Object.keys(tool.platforms).length))
    throw new Error('Tool installation requires platform assets');
  if (tool.platforms !== undefined) {
    if (
      !tool.platforms ||
      typeof tool.platforms !== 'object' ||
      Array.isArray(tool.platforms) ||
      Object.keys(tool.platforms).length > 32
    )
      throw new Error('Invalid tool platforms');
    for (const [platform, asset] of Object.entries(tool.platforms)) {
      if (
        !/^(darwin|linux|win32)-(arm64|x64)$/.test(platform) ||
        !asset ||
        typeof asset.url !== 'string' ||
        asset.url.length > 2048 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !['raw', 'zip', 'tar.gz'].includes(asset.format) ||
        !safeToolPath(asset.executable)
      )
        throw new Error('Invalid binary tool asset');
      toolUrl(asset.url);
    }
  }
  return {
    apiVersion: 1,
    name: tool.name,
    version: tool.version,
    command: tool.command,
    description: tool.description,
    entry: tool.entry,
    permissions: [...tool.permissions].sort(),
    execution: { args: [...execution.args], env: { ...execution.env } },
    ...(tool.platforms ? { platforms: tool.platforms } : {}),
  };
}
