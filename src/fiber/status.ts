import { checkNodeReadiness } from '../devnet/readiness';
import {
  getProcessCommandLine,
  isProcessAlive,
  nodeDaemonPaths,
  readPidFile,
  verifyDaemonIdentity,
} from '../util/daemon';
import { readSettings, Settings } from '../cfg/setting';
import { fiberAccountIndex, fiberDaemonPaths, fiberP2pAddr, fiberRpcUrl } from './paths';
import { readNodesYml } from './nodes-yml';
import { fiberNodeAccount, fiberPublicKeyFromSecret, readFiberNodeSecretKey } from './accounts';
import { readRuntime, FiberRuntime } from './runtime';
import { fnnNodeInfo, FnnNodeInfo } from './rpc';
import { logger } from '../util/logger';

export type FiberNodeStatus = 'starting' | 'running' | 'stopped' | 'unknown' | 'conflict';
export type OffckbManaged = 'yes' | 'no' | 'unknown';

export interface FiberNodeStatusEntry {
  id: number;
  status: FiberNodeStatus;
  offckb: OffckbManaged;
  rpcUrl: string;
  p2pAddr: string;
  accountIndex: number;
  reasons: string[];
  version?: string;
  commitHash?: string;
  chainHash?: string;
  pubkey?: string;
}

export interface FiberStatusReport {
  ckb: {
    status: 'running' | 'stopped';
    rpcUrl: string;
    proxyUrl: string;
    error?: string;
  };
  nodes: FiberNodeStatusEntry[];
}

async function resolveOffckbManaged(runtime: FiberRuntime | null, settings: Settings): Promise<OffckbManaged> {
  if (runtime == null) return 'no';
  let alive: boolean;
  try {
    alive = isProcessAlive(runtime.managerPid);
  } catch {
    return 'unknown';
  }
  if (!alive) return 'no';

  // A daemon PID file that claims fiber management must agree with the
  // runtime record, and the process behind it must verify as that daemon —
  // the same hardened identity check every other PID-file consumer uses.
  // (The fiber daemon PID file always claims management; the node daemon PID
  // file only when the fiber manager IS the node daemon, node --fiber
  // --daemon. An unrelated CKB daemon does not disqualify.)
  const fiberPid = readPidFile(fiberDaemonPaths(settings).pidFile);
  if (fiberPid != null && fiberPid.pid === runtime.managerPid) {
    return (await verifyDaemonIdentity(fiberPid.pid, fiberPid)) ? 'yes' : 'no';
  }
  if (fiberPid != null) return 'no';
  const nodePid = readPidFile(nodeDaemonPaths(settings).pidFile);
  if (nodePid != null && nodePid.pid === runtime.managerPid) {
    return (await verifyDaemonIdentity(nodePid.pid, nodePid)) ? 'yes' : 'no';
  }
  // A foreground manager has no PID file; fall back to a command-line probe.
  const cmdline = await getProcessCommandLine(runtime.managerPid);
  if (cmdline == null) return 'unknown';
  return cmdline.includes('offckb') ? 'yes' : 'no';
}

// Case-insensitive comparison of an FNN-reported funding lock against the
// expected CKB account lock. Shared by the status report and the manager's
// startup validation so the comparison rules cannot diverge.
export function lockMatches(
  actual: { code_hash: string; hash_type: string; args: string } | undefined,
  expected: { codeHash: string; hashType: string; args: string },
): boolean {
  return (
    actual != null &&
    actual.code_hash.toLowerCase() === expected.codeHash.toLowerCase() &&
    actual.hash_type.toLowerCase() === expected.hashType.toLowerCase() &&
    actual.args.toLowerCase() === expected.args.toLowerCase()
  );
}

/**
 * Check the live state of the devnet and every configured FNN. Status is
 * derived only from this moment's RPC answers and key material — no
 * list-hashes, no genesis comparison, no port inspection. The single
 * exception is process ownership (the OFFCKB column), which only gates the
 * 'starting' display of unreachable nodes: a runtime record that says
 * 'starting' is trusted unless ownership is disproven.
 */
export async function collectFiberStatus(settings: Settings = readSettings()): Promise<FiberStatusReport> {
  const ckbReadiness = await checkNodeReadiness(settings.devnet.rpcUrl, 2000);
  const report: FiberStatusReport = {
    ckb: {
      status: ckbReadiness.ready ? 'running' : 'stopped',
      rpcUrl: settings.devnet.rpcUrl,
      proxyUrl: `http://127.0.0.1:${settings.devnet.rpcProxyPort}`,
      ...(ckbReadiness.ready ? {} : { error: ckbReadiness.error ?? 'unavailable' }),
    },
    nodes: [],
  };

  const entries = readNodesYml(settings);
  if (entries == null) return report;

  const runtime = readRuntime(settings);
  const offckb = await resolveOffckbManaged(runtime, settings);
  const managerStarting = runtime != null && offckb !== 'no' && runtime.status === 'starting';

  // Probe every node concurrently: a stopped node costs the full 2s timeout,
  // and a sequential loop would block `fiber status` for 2s per down node.
  const infos = await Promise.all(
    entries.map((entry) => fnnNodeInfo(fiberRpcUrl(entry.id), 2000).catch(() => null as FnnNodeInfo | null)),
  );

  for (const [index, entry] of entries.entries()) {
    const statusEntry: FiberNodeStatusEntry = {
      id: entry.id,
      status: 'unknown',
      offckb,
      rpcUrl: fiberRpcUrl(entry.id),
      p2pAddr: fiberP2pAddr(entry.id),
      accountIndex: fiberAccountIndex(entry.id),
      reasons: [],
    };
    report.nodes.push(statusEntry);

    const info: FnnNodeInfo | null = infos[index];

    if (info == null) {
      statusEntry.status = managerStarting ? 'starting' : 'stopped';
      continue;
    }

    statusEntry.version = info.version;
    statusEntry.commitHash = info.commit_hash;
    statusEntry.chainHash = info.chain_hash;
    statusEntry.pubkey = typeof info.pubkey === 'string' ? info.pubkey : undefined;

    const secret = readFiberNodeSecretKey(entry.id, settings);
    if (secret == null) {
      statusEntry.status = 'unknown';
      statusEntry.reasons.push('cannot read the node identity key (fiber/sk); node may not have started yet');
      continue;
    }
    const expectedPubkey = fiberPublicKeyFromSecret(secret);
    const account = fiberNodeAccount(entry.id);

    let conflict = false;
    if (typeof info.pubkey !== 'string' || info.pubkey.length === 0) {
      statusEntry.reasons.push('node_info did not return a node public key');
    } else if (info.pubkey.toLowerCase() !== expectedPubkey) {
      conflict = true;
      statusEntry.reasons.push(
        `node public key mismatch: expected ${expectedPubkey} (from fiber/sk), got ${info.pubkey}`,
      );
    }
    if (!info.default_funding_lock_script) {
      statusEntry.reasons.push('node_info did not return default_funding_lock_script');
    } else if (!lockMatches(info.default_funding_lock_script, account.lockScript)) {
      conflict = true;
      statusEntry.reasons.push(
        `CKB account mismatch: expected account #${statusEntry.accountIndex} (lock args ${account.lockScript.args}), ` +
          `got ${JSON.stringify(info.default_funding_lock_script)}`,
      );
    }

    if (conflict) {
      statusEntry.status = 'conflict';
    } else if (statusEntry.reasons.length > 0) {
      statusEntry.status = 'unknown';
    } else {
      statusEntry.status = 'running';
    }
  }

  return report;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function printFiberStatus(report: FiberStatusReport) {
  const ckbLine = [
    pad('CKB', 10),
    pad(report.ckb.status, 9),
    `RPC ${report.ckb.rpcUrl}`,
    `PROXY ${report.ckb.proxyUrl}`,
  ].join(' ');
  logger.info(ckbLine);
  if (report.ckb.error) {
    logger.info(`          ${report.ckb.error}`);
  }
  logger.info('');

  if (report.nodes.length === 0) {
    logger.info('No fiber environment found (no fiber/nodes.yml). Start one with: offckb fiber start');
    return;
  }

  const header = ['NODE', 'STATUS', 'OFFCKB', 'RPC', 'P2P', 'ACCOUNT', 'VERSION', 'COMMIT'];
  const widths = [6, 9, 8, 26, 26, 9, 12, 10];
  logger.info(header.map((cell, i) => pad(cell, widths[i])).join(' '));
  for (const node of report.nodes) {
    const row = [
      pad(String(node.id), widths[0]),
      pad(node.status, widths[1]),
      pad(node.offckb, widths[2]),
      pad(node.rpcUrl, widths[3]),
      pad(node.p2pAddr, widths[4]),
      pad(String(node.accountIndex), widths[5]),
      pad(node.version ?? '-', widths[6]),
      pad(node.commitHash ? node.commitHash.slice(0, 7) : '-', widths[7]),
    ].join(' ');
    logger.info(row);
    for (const reason of node.reasons) {
      logger.info(`  ! ${reason}`);
    }
  }
}

export async function fiberStatus(settings: Settings = readSettings()) {
  const report = await collectFiberStatus(settings);
  printFiberStatus(report);
  logger.result({
    command: 'fiber.status',
    ckb: report.ckb,
    nodes: report.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      offckbManaged: node.offckb,
      rpcUrl: node.rpcUrl,
      p2pAddr: node.p2pAddr,
      accountIndex: node.accountIndex,
      version: node.version,
      commitHash: node.commitHash,
      chainHash: node.chainHash,
      pubkey: node.pubkey,
      reasons: node.reasons,
    })),
  });
}
