import { readSettings } from '../cfg/setting';
import { CKBTui } from '../tools/ckb-tui';
import { Network } from '../type/base';
import { logger } from '../util/logger';
import * as net from 'net';

export interface StatusOptions {
  network: Network;
}

type NetworkSettingsKey = 'devnet' | 'testnet' | 'mainnet';

const NETWORK_SETTINGS_KEY: Record<Network, NetworkSettingsKey> = {
  [Network.devnet]: 'devnet',
  [Network.testnet]: 'testnet',
  [Network.mainnet]: 'mainnet',
};

export async function status({ network }: StatusOptions) {
  const settings = readSettings();
  const networkKey = NETWORK_SETTINGS_KEY[network];
  const port = settings[networkKey].rpcProxyPort;
  const url = `http://127.0.0.1:${port}`;
  const isListening = await isRPCPortListening(port);
  if (!isListening) {
    logger.error(
      `RPC port ${port} is not listening. Please make sure the ${network} node is running and Proxy RPC is enabled.`,
    );
    return;
  }
  const result = CKBTui.run(['-r', url]);
  // Propagate ckb-tui exit code so scripts can detect TUI failure
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

async function isRPCPortListening(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  const client = new net.Socket();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const TIMEOUT_MS = 2000;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        resolve(false);
      }
    }, TIMEOUT_MS);
    client.once('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(false);
      }
    });
    client.once('connect', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        client.end();
        resolve(true);
      }
    });
    client.connect(port, '127.0.0.1');
  });
}
