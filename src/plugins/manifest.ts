import fs from 'fs';
import path from 'path';
import semver from 'semver';

export const PLUGIN_PERMISSIONS = ['devnet-read', 'project-deployment', 'serve'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginMode = 'sandbox' | 'trusted';
/** JS plugins run a declared entry under the host protocol; binary plugins expose a managed native binary. */
export type PluginKind = 'js' | 'binary';

export interface NativeRelease {
  repo: string;
  /** Asset file name template; must contain {tag} and {target}. */
  asset: string;
  /** Checksum file name template; may reference {asset}, {tag} and {target}. Required. */
  checksum: string;
}

export interface PluginManifest {
  directory: string;
  kind: PluginKind;
  name: string;
  version: string;
  command: string;
  description: string;
  /** js kind only */
  entry?: string;
  node?: string;
  /** binary kind only */
  binaryName?: string;
  release?: NativeRelease;
  minVersion?: string;
  permissions: PluginPermission[];
}

export function isPluginCommand(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}

/** A native binary file name: no separators, no traversal, no drive letters. */
export function isBinaryName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
}

export function readJsonFile(file: string): unknown {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Expected a JSON file under 1 MiB: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

interface NativeDescriptorFile {
  apiVersion?: number;
  kind?: string;
  name?: unknown;
  version?: unknown;
  command?: unknown;
  description?: unknown;
  binary?: { name?: unknown };
  release?: { repo?: unknown; asset?: unknown; checksum?: unknown };
  minVersion?: unknown;
}

const RELEASE_TEMPLATE = /\{tag\}/;
const TARGET_TEMPLATE = /\{target\}/;

/** Validate a native (binary) tool descriptor, from a repo file or the first-party catalog. */
export function readNativeDescriptor(
  raw: unknown,
  source: string,
): Omit<PluginManifest, 'directory' | 'entry' | 'node'> {
  const value = (raw ?? {}) as NativeDescriptorFile;
  if (value.apiVersion !== 1 || value.kind !== 'binary') {
    throw new Error(`Expected an offckb binary descriptor with apiVersion 1 and kind "binary": ${source}`);
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`Invalid binary tool name in descriptor: ${source}`);
  }
  if (!isPluginCommand(value.command)) {
    throw new Error(`Invalid binary tool command in descriptor: ${source}`);
  }
  if (!value.binary || !isBinaryName(value.binary.name)) {
    throw new Error(`Invalid binary name in descriptor: ${source}`);
  }
  const release = value.release ?? {};
  if (
    typeof release.repo !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release.repo) ||
    typeof release.asset !== 'string' ||
    !RELEASE_TEMPLATE.test(release.asset) ||
    !TARGET_TEMPLATE.test(release.asset) ||
    typeof release.checksum !== 'string' ||
    !/\{asset\}|\{tag\}/.test(release.checksum)
  ) {
    throw new Error(
      `Binary descriptor release must pin a github "repo", an "asset" template with {tag}/{target}, and a "checksum" template with {tag}: ${source}`,
    );
  }
  if (value.minVersion !== undefined && (typeof value.minVersion !== 'string' || !semver.valid(value.minVersion))) {
    throw new Error(`Invalid minVersion in descriptor: ${source}`);
  }
  return {
    kind: 'binary',
    name: value.name,
    version: typeof value.version === 'string' ? value.version : '',
    command: value.command,
    description: typeof value.description === 'string' ? value.description : value.name,
    binaryName: String(value.binary.name),
    release: {
      repo: release.repo,
      asset: release.asset,
      checksum: release.checksum,
    },
    ...(typeof value.minVersion === 'string' ? { minVersion: value.minVersion } : {}),
    permissions: [],
  };
}

export function readPluginManifest(directory: string): PluginManifest {
  const root = fs.realpathSync(directory);
  // Binary tool plugins publish a static descriptor instead of a JS package.
  const nativeDescriptor = path.join(root, 'offckb-plugin.json');
  if (fs.existsSync(nativeDescriptor)) {
    const descriptor = readNativeDescriptor(readJsonFile(nativeDescriptor), nativeDescriptor);
    const binaryPath = path.join(root, nativeBinaryFileName(descriptor.binaryName!));
    if (!fs.statSync(binaryPath).isFile()) throw new Error(`Managed binary is missing: ${binaryPath}`);
    return { ...descriptor, directory: root, permissions: [] };
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
    kind: 'js',
    name: pkg.name,
    version: String(pkg.version),
    command: declaration.command,
    entry,
    description: typeof declaration.description === 'string' ? declaration.description : pkg.name,
    permissions: [...permissions].sort(),
    ...(typeof node === 'string' ? { node } : {}),
  };
}

/** The on-disk binary file name for this host, appending .exe on Windows when absent. */
export function nativeBinaryFileName(name: string): string {
  if (process.platform !== 'win32' || /\.exe$/i.test(name)) return name;
  return `${name}.exe`;
}

export function assertPluginCompatible(plugin: PluginManifest): void {
  if (plugin.kind === 'binary') return;
  if (plugin.node && !semver.satisfies(process.versions.node, plugin.node)) {
    throw new Error(`${plugin.command} requires Node ${plugin.node}; running ${process.versions.node}`);
  }
}
