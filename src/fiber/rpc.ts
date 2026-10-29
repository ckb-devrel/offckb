import * as net from 'net';
import { callJsonRpc, JsonRpcError } from '../util/json-rpc';
import { FiberAuthError, FiberRpcAuth, readRpcToken } from './auth';

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

async function fiberRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeout: number,
  auth?: FiberRpcAuth,
): Promise<unknown> {
  const token = readRpcToken(auth);
  try {
    return await callJsonRpc(rpcUrl, method, params, timeout, token ? { Authorization: `Bearer ${token}` } : {});
  } catch (error) {
    if (
      (error instanceof JsonRpcError && (error.status === 401 || error.status === 403)) ||
      /unauthorized|permission denied|biscuit|authentication/i.test((error as Error).message)
    ) {
      throw new FiberAuthError(
        `Fiber RPC authentication failed or permission denied at ${rpcUrl}; check ${auth?.tokenFile ?? 'the configured token'}.`,
      );
    }
    if (token && error instanceof Error) error.message = error.message.split(token).join('[redacted]');
    throw error;
  }
}
export async function fnnNodeInfo(rpcUrl: string, timeoutMs = 3000, auth?: FiberRpcAuth): Promise<FnnNodeInfo> {
  const result = await fiberRpc(rpcUrl, 'node_info', [], timeoutMs, auth);
  if (!result || typeof result !== 'object') throw new JsonRpcError(`Invalid node_info response from ${rpcUrl}`);
  return result as FnnNodeInfo;
}
export async function fnnConnectPeer(
  rpcUrl: string,
  address: string,
  save = true,
  timeoutMs = 10000,
  auth?: FiberRpcAuth,
): Promise<void> {
  await fiberRpc(rpcUrl, 'connect_peer', [{ address, save }], timeoutMs, auth);
}
export async function fnnListPeers(rpcUrl: string, timeoutMs = 3000, auth?: FiberRpcAuth): Promise<FnnPeerInfo[]> {
  const result = (await fiberRpc(rpcUrl, 'list_peers', [], timeoutMs, auth)) as { peers?: FnnPeerInfo[] };
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
