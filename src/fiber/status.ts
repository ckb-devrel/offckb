import { checkNodeReadiness } from '../devnet/readiness';
import {
  getProcessCommandLine,
  isProcessAlive,
  nodeDaemonPaths,
  readPidFile,
  verifyDaemonIdentity,
} from '../util/daemon';
import { readSettings, Settings } from '../cfg/setting';
import { fiberDaemonPaths, fiberP2pAddr, fiberRpcUrl } from './paths';
import { readNodesYml, resolveNodeFile } from './nodes-yml';
import { resolveFundingAccount, fiberPublicKeyFromSecret, readFiberNodeSecretKey } from './accounts';
import { readRuntime, FiberRuntime } from './runtime';
import { fnnNodeInfo } from './rpc';
import { logger } from '../util/logger';
import { customConfig, CustomConfig, readNodeConfig } from './config-gen';
import { isMapping } from './files';
import { FiberAuthError } from './auth';

export type FiberNodeStatus = 'starting' | 'running' | 'stopped' | 'unknown' | 'conflict';
export type OffckbManaged = 'yes' | 'no' | 'unknown';

export interface FiberNodeStatusEntry {
  id: number;
  status: FiberNodeStatus;
  offckb: OffckbManaged;
  rpcUrl: string;
  p2pAddr: string;
  accountIndex?: number;
  fundingAddress?: string;
  customConfig: CustomConfig;
  configFile?: string;
  tokenFile?: string;
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

  const runtime = readRuntime(settings);
  const offckb = await resolveOffckbManaged(runtime, settings);
  const active = runtime != null && offckb !== 'no' ? runtime : null;
  // A live manager's snapshot wins even if files were edited or damaged.
  let entries: ReturnType<typeof readNodesYml> = null;
  let registryError: string | undefined;
  try {
    entries = readNodesYml(settings);
  } catch (error) {
    if (!active) throw error;
    registryError = (error as Error).message;
  }
  const ids = [
    ...new Set([...(active?.nodes.map((node) => node.id) ?? []), ...(entries?.map((node) => node.id) ?? [])]),
  ].sort((a, b) => a - b);
  await Promise.all(
    ids.map(async (id) => {
      const running = active?.nodes.find((node) => node.id === id);
      const entry = entries?.find((node) => node.id === id);
      const statusEntry: FiberNodeStatusEntry = {
        id,
        status: 'unknown',
        offckb: running ? offckb : 'no',
        rpcUrl: running?.rpcUrl ?? fiberRpcUrl(id),
        p2pAddr: fiberP2pAddr(id),
        accountIndex: running
          ? running.accountIndex
          : entry?.account.type === 'builtin'
            ? entry.account.index
            : undefined,
        fundingAddress: running?.fundingAddress,
        customConfig: running?.customConfig ?? (entry ? customConfig(entry, settings) : 'unknown'),
        configFile: running?.configFile ?? (entry ? resolveNodeFile(entry.config_file, settings) : undefined),
        tokenFile: running?.tokenFile ?? (entry ? resolveNodeFile(entry.rpc_token_file, settings) : undefined),
        reasons: [],
      };
      report.nodes.push(statusEntry);
      if (!running)
        statusEntry.reasons.push('configuration has not taken effect; it will be used on the next successful start');
      if (registryError) statusEntry.reasons.push(registryError);
      if (statusEntry.customConfig === 'unknown')
        statusEntry.reasons.push('cannot determine custom config: default config is missing or invalid');
      let expectedLock = running?.fundingLock;
      let auth = running?.authEnabled ? { tokenFile: running.tokenFile! } : undefined;
      try {
        if (!running && entry) {
          const account = resolveFundingAccount(entry.account);
          expectedLock = account.lockScript;
          statusEntry.fundingAddress = account.address;
          if (!entry.initialized) {
            statusEntry.status = 'stopped';
            return;
          }
          const config = readNodeConfig(entry, settings);
          auth =
            isMapping(config.rpc) && config.rpc.biscuit_public_key ? { tokenFile: statusEntry.tokenFile! } : undefined;
        }
        const info = await fnnNodeInfo(statusEntry.rpcUrl, 2000, auth);
        statusEntry.version = info.version;
        statusEntry.commitHash = info.commit_hash;
        statusEntry.chainHash = info.chain_hash;
        statusEntry.pubkey = info.pubkey;
        const secret = readFiberNodeSecretKey(id, settings);
        if (!secret) {
          statusEntry.reasons.push('cannot read the node identity key (fiber/sk)');
          return;
        }
        const expectedPubkey = fiberPublicKeyFromSecret(secret);
        if (typeof info.pubkey !== 'string' || info.pubkey.toLowerCase() !== expectedPubkey) {
          statusEntry.status = 'conflict';
          statusEntry.reasons.push('node public key does not match fiber/sk');
        } else if (!expectedLock || !lockMatches(info.default_funding_lock_script, expectedLock)) {
          statusEntry.status = 'conflict';
          statusEntry.reasons.push('CKB funding lock does not match the saved account binding');
        } else statusEntry.status = 'running';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (error instanceof FiberAuthError) statusEntry.reasons.push(error.message);
        else if (code === 'ECONNREFUSED' || /timed out/.test((error as Error).message)) {
          statusEntry.status = running && active?.status === 'starting' ? 'starting' : 'stopped';
        } else statusEntry.reasons.push((error as Error).message);
      }
    }),
  );
  report.nodes.sort((a, b) => a.id - b.id);

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

  const header = ['NODE', 'STATUS', 'OFFCKB', 'CUSTOM_CONFIG', 'RPC', 'P2P', 'ACCOUNT', 'VERSION', 'COMMIT'];
  const widths = [6, 9, 8, 15, 26, 26, 9, 12, 10];
  logger.info(header.map((cell, i) => pad(cell, widths[i])).join(' '));
  for (const node of report.nodes) {
    const row = [
      pad(String(node.id), widths[0]),
      pad(node.status, widths[1]),
      pad(node.offckb, widths[2]),
      pad(node.customConfig, widths[3]),
      pad(node.rpcUrl, widths[4]),
      pad(node.p2pAddr, widths[5]),
      pad(node.accountIndex == null ? 'random' : String(node.accountIndex), widths[6]),
      pad(node.version ?? '-', widths[7]),
      pad(node.commitHash ? node.commitHash.slice(0, 7) : '-', widths[8]),
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
      fundingAddress: node.fundingAddress,
      customConfig: node.customConfig,
      configFile: node.configFile,
      rpcTokenFile: node.tokenFile,
      version: node.version,
      commitHash: node.commitHash,
      chainHash: node.chainHash,
      pubkey: node.pubkey,
      reasons: node.reasons,
    })),
  });
}
