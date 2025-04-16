import * as fs from 'fs';
import * as path from 'path';
import envPaths from './env-path';

const paths = envPaths('offckb');

export const configPath = path.join(paths.config, 'settings.json');
export const dataPath = paths.data;
export const cachePath = paths.cache;

export const packageSrcPath = path.dirname(require.main!.filename);
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
  rpc: {
    proxyPort: number;
  };
  bins: {
    rootFolder: string;
    defaultCKBVersion: string;
    downloadPath: string;
  };
  devnet: {
    rpcUrl: string;
    configPath: string;
    dataPath: string;
    debugFullTransactionsPath: string;
    transactionsPath: string;
    failedTransactionsPath: string;
    contractsPath: string;
  };
  testnet: {
    rpcUrl: string;
    debugFullTransactionsPath: string;
    transactionsPath: string;
    failedTransactionsPath: string;
    contractsPath: string;
  };
  mainnet: {
    rpcUrl: string;
    debugFullTransactionsPath: string;
    transactionsPath: string;
    failedTransactionsPath: string;
    contractsPath: string;
  };
  dappTemplate: {
    gitRepoUrl: string;
    gitBranch: string;
    gitFolder: string;
    downloadPath: string;
  };
  tools: {
    moleculeES: {
      downloadPath: string;
      cachePath: string;
      binFolder: string;
    };
    ckbDebugger: {
      minVersion: string;
    };
  };
}

export const defaultSettings: Settings = {
  proxy: undefined,
  rpc: {
    proxyPort: 9000,
  },
  bins: {
    rootFolder: path.resolve(dataPath, 'bins'),
    defaultCKBVersion: '0.201.0',
    downloadPath: path.resolve(cachePath, 'download'),
  },
  devnet: {
    rpcUrl: 'http://localhost:8114',
    // todo: maybe add a root folder for all devnet data
    // so we can clean it easily
    configPath: path.resolve(dataPath, 'devnet'),
    dataPath: path.resolve(dataPath, 'devnet/data'),
    debugFullTransactionsPath: path.resolve(dataPath, 'devnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'devnet/transactions'),
    failedTransactionsPath: path.resolve(dataPath, 'devnet/failed-transactions'),
    contractsPath: path.resolve(dataPath, 'devnet/contracts'),
  },
  testnet: {
    rpcUrl: 'https://testnet.ckb.dev',
    debugFullTransactionsPath: path.resolve(dataPath, 'testnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'testnet/transactions'),
    failedTransactionsPath: path.resolve(dataPath, 'testnet/failed-transactions'),
    contractsPath: path.resolve(dataPath, 'testnet/contracts'),
  },
  mainnet: {
    rpcUrl: 'https://mainnet.ckb.dev',
    debugFullTransactionsPath: path.resolve(dataPath, 'mainnet/full-transactions'),
    transactionsPath: path.resolve(dataPath, 'mainnet/transactions'),
    failedTransactionsPath: path.resolve(dataPath, 'mainnet/failed-transactions'),
    contractsPath: path.resolve(dataPath, 'mainnet/contracts'),
  },
  dappTemplate: {
    gitRepoUrl: `https://github.com/ckb-devrel/offckb`,
    gitBranch: 'master',
    gitFolder: 'templates/v3',
    downloadPath: path.resolve(cachePath, 'download', 'dapp-template'),
  },
  tools: {
    moleculeES: {
      downloadPath: path.resolve(cachePath, 'download', 'molecule-es'),
      cachePath: path.resolve(cachePath, 'tools', 'moleculec-es'),
      binFolder: path.resolve(dataPath, 'tools', 'moleculec-es'),
    },
    ckbDebugger: {
      minVersion: '0.200.0',
    },
  },
};

export function readSettings(): Settings {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return deepMerge(defaultSettings, JSON.parse(data)) as Settings;
    } else {
      return defaultSettings;
    }
  } catch (error) {
    console.error('Error reading settings:', error);
    return defaultSettings;
  }
}

export function writeSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
    console.log('save new settings');
  } catch (error) {
    console.error('Error writing settings:', error);
  }
}

export function getCKBBinaryInstallPath(version: string) {
  const setting = readSettings();
  return `${setting.bins.rootFolder}/${version}`;
}

export function getCKBBinaryPath(version: string) {
  return `${getCKBBinaryInstallPath(version)}/ckb`;
}

function deepMerge(target: any, source: any): any {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object') {
      if (!target[key]) {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
