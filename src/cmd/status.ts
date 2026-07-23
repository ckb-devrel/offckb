import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';
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

/**
 * Best-effort lookup of the devnet node's TCP subscription endpoint from its
 * ckb.toml. ckb-tui connects to it directly (the OffCKB proxy is HTTP-only) to
 * stream new/rejected transactions and logs; when absent, those dashboards
 * simply stay empty, so any failure here is non-fatal.
 */
function devnetTcpListenAddress(): string | undefined {
  try {
    const settings = readSettings();
    const ckbTomlPath = path.join(settings.devnet.configPath, 'ckb.toml');
    if (!fs.existsSync(ckbTomlPath)) return undefined;
    const parsed = toml.parse(fs.readFileSync(ckbTomlPath, 'utf8'));
    const rpc = parsed.rpc as JsonMap | undefined;
    const address = rpc?.tcp_listen_address;
    if (typeof address !== 'string' || address.trim().length === 0) return undefined;
    // A wildcard bind is not a dialable address; the node runs on this host.
    return address.trim().replace(/^0\.0\.0\.0:/, '127.0.0.1:');
  } catch {
    return undefined;
  }
}

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
  const args = ['-r', url];
  if (network === Network.devnet) {
    const tcpAddress = devnetTcpListenAddress();
    if (tcpAddress) {
      args.push('-t', tcpAddress);
    }
  }
  const result = CKBTui.run(args);
  // Propagate ckb-tui exit code so scripts can detect TUI failure
  if (result.status !== 0) {
    throw new Error(`ckb-tui exited with code ${result.status ?? 'unknown'}`);
  }
}
