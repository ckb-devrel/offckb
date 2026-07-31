import * as net from 'net';
import { callJsonRpc } from '../util/json-rpc';

export interface FnnNodeInfo {
  version: string;
  commit_hash: string;
  pubkey: string;
  node_name?: string | null;
  addresses: string[];
  chain_hash: string;
  default_funding_lock_script: {
    code_hash: string;
    hash_type: string;
    args: string;
  };
  peers_count: string | number;
  channel_count: string | number;
}

export interface FnnPeerInfo {
  pubkey: string;
  address: string;
}

export async function fnnNodeInfo(rpcUrl: string, timeoutMs = 3000): Promise<FnnNodeInfo> {
  return (await callJsonRpc(rpcUrl, 'node_info', [], timeoutMs)) as FnnNodeInfo;
}

export async function fnnConnectPeer(rpcUrl: string, address: string, save = true, timeoutMs = 10000): Promise<void> {
  await callJsonRpc(rpcUrl, 'connect_peer', [{ address, save }], timeoutMs);
}

export async function fnnListPeers(rpcUrl: string, timeoutMs = 3000): Promise<FnnPeerInfo[]> {
  const result = (await callJsonRpc(rpcUrl, 'list_peers', [], timeoutMs)) as { peers?: FnnPeerInfo[] };
  return result?.peers ?? [];
}

export function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}
