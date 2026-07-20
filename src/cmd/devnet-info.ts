import { readSettings } from '../cfg/setting';
import { readForkState } from '../devnet/fork';
import { checkNodeReadiness } from '../devnet/readiness';
import { logger } from '../util/logger';

export async function devnetInfo() {
  const settings = readSettings();
  const fork = readForkState(settings.devnet.configPath);
  const readiness = await checkNodeReadiness(settings.devnet.rpcUrl);
  const indexerReady = readiness.indexerTip != null && readiness.indexerLag === BigInt(0);
  const networkIsolated = fork && readiness.peers != null ? readiness.peers === 0 : undefined;
  const result = {
    command: 'devnet.info',
    kind: fork ? `fork-of-${fork.source}` : 'pure-devnet',
    configPath: settings.devnet.configPath,
    rpcUrl: settings.devnet.rpcUrl,
    proxyUrl: `http://127.0.0.1:${settings.devnet.rpcProxyPort}`,
    ready: readiness.ready,
    nodeTip: readiness.nodeTip?.toString(),
    indexerTip: readiness.indexerTip?.toString(),
    indexerLag: readiness.indexerLag?.toString(),
    indexerReady,
    peers: readiness.peers,
    networkIsolated,
    error: readiness.error,
    fork,
  };

  logger.info(`Devnet: ${result.kind}`);
  logger.info(`RPC: ${result.rpcUrl}`);
  logger.info(`Proxy RPC: ${result.proxyUrl}`);
  logger.info(`Node ready: ${result.ready ? 'yes' : 'no'}`);
  if (readiness.nodeTip != null) logger.info(`Node tip: ${readiness.nodeTip}`);
  if (readiness.indexerTip != null) logger.info(`Indexer tip: ${readiness.indexerTip}`);
  if (readiness.indexerLag != null) {
    const message = `Indexer lag: ${readiness.indexerLag}`;
    if (readiness.indexerLag > BigInt(0)) logger.warn(`${message}; indexed queries may be stale.`);
    else logger.info(message);
  }
  logger.info(`Indexer ready: ${indexerReady ? 'yes' : 'no'}`);
  if (readiness.peers != null) logger.info(`Peers: ${readiness.peers}`);
  if (fork)
    logger.info(`Public network isolated: ${networkIsolated == null ? 'unknown' : networkIsolated ? 'yes' : 'NO'}`);
  if (fork && readiness.peers != null && readiness.peers > 0) {
    logger.warn('A forked devnet has connected peers. Stop it and inspect ckb.toml before signing or mining.');
  }
  if (fork?.source === 'mainnet') {
    logger.warn('MAINNET FORK REPLAY RISK: only sign with built-in dev keys and fork-mined cells.');
  }
  if (readiness.error) logger.warn(readiness.error);
  logger.result(result);
  return result;
}
