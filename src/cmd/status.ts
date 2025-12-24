import { readSettings } from '../cfg/setting';
import { CKBTui } from '../tools/ckb-tui';
import { Network } from '../type/base';
import { logger } from '../util/logger';
import * as net from 'net';

export interface StatusOptions {
  network?: Network;
}

export async function status({ network }: StatusOptions) {
  const settings = readSettings();
  const port =
    network === Network.devnet
      ? settings.devnet.rpcProxyPort
      : network === Network.testnet
        ? settings.testnet.rpcProxyPort
        : settings.mainnet.rpcProxyPort;
  const url = `http://127.0.0.1:${port}`;
  const isListening = await isRPCPortListening(port);
  if (!isListening) {
    logger.error(
      `RPC port ${port} is not listening. Please make sure the ${network} node is running and Proxy RPC is enabled.`,
    );
    return;
  }
  CKBTui.run(['-r', url]);
}

async function isRPCPortListening(port: number): Promise<boolean> {
  const client = new net.Socket();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const TIMEOUT_MS = 5000;
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
