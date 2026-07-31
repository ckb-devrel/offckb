import * as fs from 'fs';
import * as path from 'path';
import envPaths from './env-path';
import { logger } from '../util/logger';

const paths = envPaths('offckb');

export const configPath = path.join(paths.config, 'settings.json');
export const dataPath = paths.data;
export const cachePath = paths.cache;

export const packageSrcPath = path.dirname(require.main?.filename || __filename);
export const packageRootPath = path.resolve(packageSrcPath, '../');

export interface ProxyBasicCredentials {
  username: string;
  password: string;
}

export interface ProxyConfig {
  host: string;
  port: number;
  auth?: ProxyBasicCredentials;
  protocol?: string;
}

export interface Settings {
  proxy?: ProxyConfig;
  bins: {
    rootFolder: string;
    defaultCKBVersion: string;
    downloadPath: string;
  };
  devnet: {
    rpcUrl: string;
    rpcProxyPort: number;
    configPath: string;
    dataPath: string;
    debugFullTransactionsPath: string;
    transactionsPath: string;
  };
  testnet: {
    rpcUrl: string;
    rpcProxyPort: number;
    debugFullTransactionsPath: string;
    transactionsPath: string;
  };
  mainnet: {
    rpcUrl: string;
    rpcProxyPort: number;
    debugFullTransactionsPath: string;
    transactionsPath: string;
  };
  tools: {
    rootFolder: string;
    ckbDebugger: {
      minVersion: string;
    };
    ckbTui: {
      version: string;
    };
  };
}

export const defaultSettings: Settings = {
  proxy: undefined,
  bins: {
    rootFolder: path.resolve(dataPath, 'bins'),
    defaultCKBVersion: '0.208.0',
    downloadPath: path.resolve(cachePath, 'download'),
  },
  devnet: {
    rpcUrl: 'http://127.0.0.1:8114',
    rpcProxyPort: 28114,
    // todo: maybe add a root folder for all devnet data
    // so we can clean it easily
    configPath: path.resolve(dataPath, 'devnet'),
    dataPath: path.resolve(dataPath, 'devnet/data'),
    debugFullTransactionsPath: path.resolve(dataPath, 'devnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'devnet/transactions'),
  },
  testnet: {
    rpcUrl: 'https://testnet.ckb.dev',
    rpcProxyPort: 38114,
    debugFullTransactionsPath: path.resolve(dataPath, 'testnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'testnet/transactions'),
  },
  mainnet: {
    rpcUrl: 'https://mainnet.ckb.dev',
    rpcProxyPort: 48114,
    debugFullTransactionsPath: path.resolve(dataPath, 'mainnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'mainnet/transactions'),
  },
  tools: {
    rootFolder: path.resolve(dataPath, 'tools'),
    ckbDebugger: {
      minVersion: '0.200.0',
    },
    ckbTui: {
      version: 'v0.1.4',
    },
  },
};

export function readSettings(): Settings {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(data);
      validateSettings(parsed);
      // Deep-clone defaults before merging to prevent mutation of the shared default
      const settings = deepMerge(deepClone(defaultSettings), parsed) as Settings;
      return upgradeFrozenBundledVersions(settings);
    } else {
      // Callers mutate the returned settings in place; never hand out the
      // shared module-level defaults.
      return deepClone(defaultSettings);
    }
  } catch (error) {
    logger.error('Error reading settings:', error);
    return deepClone(defaultSettings);
  }
}

export function writeSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Don't persist the bundled ckb-tui version when it merely equals the
    // shipped default: there is no CLI command that sets it, so an entry
    // identical to the default is an artifact of dumping the merged settings,
    // and writing it would freeze today's default into the user's config
    // (readSettings would keep honoring it after a future bump). A version
    // that differs from the default is a deliberate hand-edit and is kept.
    const toWrite = deepClone(settings);
    if (toWrite.tools?.ckbTui?.version === defaultSettings.tools.ckbTui.version) {
      delete (toWrite.tools as Partial<typeof toWrite.tools>).ckbTui;
    }
    fs.writeFileSync(configPath, JSON.stringify(toWrite, null, 2));
    logger.info('save new settings');
  } catch (error) {
    logger.error('Error writing settings:', error);
  }
}

/**
 * Releases up to 0.4.10 wrote the entire merged settings object on any
 * `offckb config set`, freezing the then-current bundled ckb-tui version
 * (e.g. "v0.1.3") into the user's settings.json. Since no CLI command can set
 * tools.ckbTui.version deliberately, a frozen value older than the shipped
 * default is treated as such an artifact and upgraded, so existing installs
 * pick up ckb-tui fixes (and the stale-binary reinstall keyed off the
 * configured version) instead of staying on the old release forever. A
 * persisted version newer than the default — only possible via a hand-edit —
 * is respected, as is an unparseable value (install-time validation reports
 * it). Returns -1/0/1 semantics via compareVersions; null when unparseable.
 */
function upgradeFrozenBundledVersions(settings: Settings): Settings {
  const configured = settings.tools?.ckbTui?.version;
  const shipped = defaultSettings.tools.ckbTui.version;
  if (typeof configured !== 'string' || configured === shipped) {
    return settings;
  }
  const order = compareVersions(configured, shipped);
  if (order !== null && order < 0) {
    logger.info(`Upgrading bundled ckb-tui version from ${configured} to ${shipped} (the shipped default).`);
    settings.tools.ckbTui.version = shipped;
  }
  return settings;
}

/** Compare two strict vX.Y.Z versions; null when either fails to parse. */
function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

export function getCKBBinaryInstallPath(version: string) {
  const setting = readSettings();
  return path.join(setting.bins.rootFolder, version);
}

export function getCKBBinaryPath(version: string) {
  const platform = process.platform;
  const binaryName = platform === 'win32' ? 'ckb.exe' : 'ckb';
  return path.join(getCKBBinaryInstallPath(version), binaryName);
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(deepClone) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      clone[key] = deepClone((obj as Record<string, unknown>)[key]);
    }
  }
  return clone as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  for (const key in source) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function validateSettings(raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Settings must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (obj.tools && typeof obj.tools === 'object') {
    const tools = obj.tools as Record<string, unknown>;
    if (tools.rootFolder !== undefined && typeof tools.rootFolder !== 'string') {
      throw new Error('tools.rootFolder must be a string path');
    }
    if (tools.ckbTui && typeof tools.ckbTui === 'object') {
      const ckbTui = tools.ckbTui as Record<string, unknown>;
      if (ckbTui.version !== undefined && typeof ckbTui.version !== 'string') {
        throw new Error('tools.ckbTui.version must be a string');
      }
    }
  }

  if (obj.proxy !== undefined && obj.proxy !== null) {
    if (typeof obj.proxy !== 'object') {
      throw new Error('proxy must be an object');
    }
  }
}
