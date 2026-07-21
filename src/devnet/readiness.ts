import { readSettings } from '../cfg/setting';
import { Network } from '../type/base';
import { logger } from '../util/logger';
import { callJsonRpc } from '../util/json-rpc';
import { readForkState } from './fork';

export interface NodeReadiness {
  ready: boolean;
  rpcUrl: string;
  version?: string;
  nodeTip?: bigint;
  indexerTip?: bigint;
  indexerLag?: bigint;
  peers?: number;
  error?: string;
}

function parseHexNumber(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return undefined;
  return BigInt(value);
}

export async function checkNodeReadiness(rpcUrl: string, timeoutMs = 3000): Promise<NodeReadiness> {
  try {
    const [nodeInfo, tipValue] = await Promise.all([
      callJsonRpc(rpcUrl, 'local_node_info', [], timeoutMs),
      callJsonRpc(rpcUrl, 'get_tip_block_number', [], timeoutMs),
    ]);
    const nodeTip = parseHexNumber(tipValue);
    if (nodeTip == null) {
      throw new Error(`Invalid node tip returned by ${rpcUrl}`);
    }

    let indexerTip: bigint | undefined;
    try {
      const value = await callJsonRpc(rpcUrl, 'get_indexer_tip', [], timeoutMs);
      indexerTip = parseHexNumber(value?.block_number);
    } catch {
      // Indexer readiness is reported separately and does not make the node RPC unhealthy.
    }

    let peers: number | undefined;
    try {
      const value = await callJsonRpc(rpcUrl, 'get_peers', [], timeoutMs);
      peers = Array.isArray(value) ? value.length : undefined;
    } catch {
      // The Net RPC module can be disabled on custom nodes.
    }

    const indexerLag = indexerTip == null ? undefined : indexerTip >= nodeTip ? BigInt(0) : nodeTip - indexerTip;
    return {
      ready: true,
      rpcUrl,
      version: typeof nodeInfo?.version === 'string' ? nodeInfo.version : undefined,
      nodeTip,
      indexerTip,
      indexerLag,
      peers,
    };
  } catch (error) {
    return {
      ready: false,
      rpcUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForNodeReady(
  rpcUrl: string,
  timeoutMs: number,
  isProcessAlive: () => boolean = () => true,
): Promise<NodeReadiness> {
  const start = Date.now();
  let last = await checkNodeReadiness(rpcUrl);
  while (!last.ready && isProcessAlive() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await checkNodeReadiness(rpcUrl);
  }
  return last;
}

export async function checkConfiguredDevnetReadiness(): Promise<NodeReadiness> {
  return checkNodeReadiness(readSettings().devnet.rpcUrl);
}

export async function warnIfForkIndexerIsBehind(network: Network): Promise<NodeReadiness | undefined> {
  if (network !== Network.devnet) return undefined;

  const settings = readSettings();
  if (!readForkState(settings.devnet.configPath)) return undefined;

  const readiness = await checkNodeReadiness(settings.devnet.rpcUrl);
  if (!readiness.ready) {
    logger.warn(`The forked devnet is not RPC-ready: ${readiness.error ?? 'health check failed'}`);
  } else if (readiness.indexerTip == null) {
    logger.warn(
      'The CKB indexer is not ready yet; cell and balance lookups may be incomplete. Check `offckb devnet info`.',
    );
  } else if (readiness.indexerLag && readiness.indexerLag > BigInt(0)) {
    logger.warn(
      `The CKB indexer is ${readiness.indexerLag} blocks behind the node; cell and balance lookups may be incomplete. ` +
        'Check `offckb devnet info`.',
    );
  }
  return readiness;
}
