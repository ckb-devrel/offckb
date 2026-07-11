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
    defaultCKBVersion: '0.207.0',
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
      version: 'v0.1.3',
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
      return deepMerge(deepClone(defaultSettings), parsed) as Settings;
    } else {
      return defaultSettings;
    }
  } catch (error) {
    logger.error('Error reading settings:', error);
    return defaultSettings;
  }
}

export function writeSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
    logger.info('save new settings');
  } catch (error) {
    logger.error('Error writing settings:', error);
  }
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
