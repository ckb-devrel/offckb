import { readSettings } from '../cfg/setting';
import { CKBTui } from '../tools/ckb-tui';
import { Network } from '../type/base';
import { checkNodeReadiness } from '../devnet/readiness';

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
  // ckb-tui is an interactive terminal UI. Running it without a TTY
  // (pipe, redirect, CI) would hang or produce garbage output.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      'The status command requires an interactive terminal (TTY). It cannot be used in pipes, redirects, or CI.',
    );
  }

  const settings = readSettings();
  const networkKey = NETWORK_SETTINGS_KEY[network];
  const port = settings[networkKey].rpcProxyPort;
  const url = `http://127.0.0.1:${port}`;
  const readiness = await checkNodeReadiness(url);
  if (!readiness.ready) {
    throw new Error(
      `RPC proxy ${url} is not connected to a healthy ${network} node: ${readiness.error ?? 'health check failed'}`,
    );
  }
  const result = CKBTui.run(['-r', url]);
  // Propagate ckb-tui exit code so scripts can detect TUI failure
  if (result.status !== 0) {
    throw new Error(`ckb-tui exited with code ${result.status ?? 'unknown'}`);
  }
}
