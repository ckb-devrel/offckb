import { readSettings } from '../cfg/setting';
import { CKBTui } from '../tools/ckb-tui';
import { Network } from '../type/base';
import { logger } from '../util/logger';

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
    return logger.error(
      `RPC port ${port} is not listening. Please make sure the ${network} node is running and Proxy RPC is enabled.`,
    );
  }
  return CKBTui.runWithArgs(['-r', url]);
}

async function isRPCPortListening(port: number): Promise<boolean> {
  const net = require('net');
  const client = new net.Socket();
  return new Promise<boolean>((resolve) => {
    client.once('error', () => {
      resolve(false);
    });
    client.connect(port, '127.0.0.1');
    client.once('connect', () => {
      client.end();
      resolve(true);
    });
  });
}
