import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { resolveCliEntry } from '../util/daemon';
import { resolveDevnetSystemScriptsFromListHashes } from '../scripts/private';
import { PluginManifest } from './manifest';
import { pluginHome } from './store';

export interface PluginContext {
  apiVersion: 1;
  offckbVersion: string;
  cwd: string;
  output: 'json' | 'text';
  cli: { node: string; entry: string | null };
  plugin: { command: string; dataPath: string; cachePath: string };
  devnet: {
    rpcUrl: string;
    proxyUrl: string;
    kind: 'pure-devnet' | 'fork-of-mainnet' | 'fork-of-testnet' | 'unknown';
    genesisHash: string | null;
    addressPrefix: 'ckb' | 'ckt' | null;
    systemScriptsFile: string | null;
    systemScriptsVersion: 1;
    diagnostic?: { code: 'LIST_HASHES_FAILED'; message: string };
  };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function createPluginContext(plugin: PluginManifest, json: boolean): { file: string; dispose: () => void } {
  const temporaryRoot = path.join(pluginHome(), 'tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'run-'));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const settings = readSettings({ strict: true });
    // No installation, node startup or RPC request. An uninitialized chain stays unknown.
    let scripts: ReturnType<typeof resolveDevnetSystemScriptsFromListHashes> = null;
    let diagnostic: PluginContext['devnet']['diagnostic'];
    if (
      isFile(path.join(settings.devnet.configPath, 'ckb.toml')) &&
      isFile(getCKBBinaryPath(settings.bins.defaultCKBVersion))
    ) {
      try {
        scripts = resolveDevnetSystemScriptsFromListHashes(
          execFileSync(
            getCKBBinaryPath(settings.bins.defaultCKBVersion),
            ['list-hashes', '-C', settings.devnet.configPath],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        );
      } catch {
        // Chain-independent tools can still run. Do not expose raw stderr or settings in the snapshot.
        diagnostic = {
          code: 'LIST_HASHES_FAILED',
          message: 'Local chain metadata is unavailable; check the devnet config and managed CKB binary.',
        };
      }
    }
    const systemScriptsFile = scripts ? path.join(directory, 'system-scripts.json') : null;
    if (systemScriptsFile)
      fs.writeFileSync(systemScriptsFile, JSON.stringify({ devnet: scripts!.scripts }), { mode: 0o600 });
    const data = path.join(pluginHome(), 'data', plugin.command);
    const cache = path.join(pluginHome(), 'cache', plugin.command);
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const context: PluginContext = {
      apiVersion: 1,
      offckbVersion: require('../../package.json').version,
      cwd: process.cwd(),
      output: json ? 'json' : 'text',
      cli: { node: process.execPath, entry: resolveCliEntry() },
      plugin: { command: plugin.command, dataPath: data, cachePath: cache },
      devnet: {
        rpcUrl: settings.devnet.rpcUrl,
        proxyUrl: `http://127.0.0.1:${settings.devnet.rpcProxyPort}`,
        kind: !scripts
          ? 'unknown'
          : scripts.forkedFrom
            ? `fork-of-${scripts.forkedFrom}`
            : fs.existsSync(path.join(settings.devnet.configPath, 'fork.json'))
              ? 'unknown'
              : 'pure-devnet',
        genesisHash: scripts?.genesisHash ?? null,
        addressPrefix: !scripts ? null : scripts.forkedFrom === 'mainnet' ? 'ckb' : 'ckt',
        systemScriptsFile,
        systemScriptsVersion: 1,
        ...(diagnostic ? { diagnostic } : {}),
      },
    };
    const file = path.join(directory, 'context.json');
    fs.writeFileSync(file, JSON.stringify(context), { mode: 0o600, flag: 'wx' });
    return { file, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
