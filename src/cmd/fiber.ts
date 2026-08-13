import { readSettings, Settings } from '../cfg/setting';
import { logger } from '../util/logger';
import { assertPlainDevnet, assertCkbEnvReadyForFiber } from '../fiber/ckb-env';
import { acquireEnvLock } from '../fiber/env-lock';
import { resolveFnnBinary } from '../fiber/install';
import { resolveFiberChainScripts, FiberContractsMissingError } from '../fiber/scripts';
import { startFiberEnvironment, stopFiberNodes, FiberEnvironment } from '../fiber/manager';
import { startFiberDaemon, stopFiber } from '../fiber/daemon';
import { fiberStatus } from '../fiber/status';
import { fiberClean, FiberCleanOptions } from '../fiber/clean';
import { fiberAccountIndex, fiberNodePaths, FIBER_DAEMON_PID_FILE, fiberDaemonPaths } from '../fiber/paths';
import { readNodesYml } from '../fiber/nodes-yml';
import { readLogTail, followLogFile } from '../devnet/log-file';
import { cleanupPidFile } from '../util/daemon';
import * as fs from 'fs';

export interface FiberStartOptions {
  nodes?: number;
  binaryPath?: string;
  daemon?: boolean;
}

function fiberDaemonChildArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--daemon');
}

// The error message carries the full migration guidance (rebuild via
// `offckb clean`); `node --fiber` surfaces the same text by rethrowing.
function logMissingContractsGuidance(error: FiberContractsMissingError) {
  logger.error(error.message);
}

export function printFiberSummary(env: FiberEnvironment) {
  logger.success(`Fiber environment is ready (${env.nodes.length} node(s)).`);
  for (const node of env.nodes) {
    const info = env.nodeInfos.get(node.id);
    const version = info ? `${info.version} (${(info.commit_hash || '').slice(0, 7) || 'unknown commit'})` : 'unknown';
    logger.info(
      `  node ${node.id}: FNN ${version}, RPC ${node.rpcUrl}, account #${fiberAccountIndex(node.id)}, log: ${node.logFile}`,
    );
  }
}

/**
 * Keep the current process managing the FNN children until one of them exits
 * or a stop signal arrives. An unexpected child exit stops the rest of the
 * group; a signal stops the children, drops runtime.json and exits.
 */
export async function superviseFiberNodes(
  env: FiberEnvironment,
  settings: Settings,
  extraCleanup?: () => void,
): Promise<never> {
  let stopping = false;
  const stopAll = async (reason: string, exitCode: number): Promise<never> => {
    if (stopping) {
      // A second FNN exit while we are already stopping: nothing more to do.
      return new Promise<never>(() => {});
    }
    stopping = true;
    if (reason) logger.error(reason);
    await stopFiberNodes(env.nodes, settings);
    if (process.env.OFFCKB_DAEMON_CHILD === '1') {
      cleanupPidFile(fiberDaemonPaths(settings).pidFile);
    }
    extraCleanup?.();
    process.exit(exitCode);
  };

  for (const node of env.nodes) {
    node.process.once('exit', (code, signal) => {
      void stopAll(
        `FNN node ${node.id} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}). ` +
          `See its log: ${node.logFile}`,
        typeof code === 'number' && code > 0 ? code : 1,
      );
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stopAll(`Received ${signal}, stopping fiber nodes...`, signal === 'SIGINT' ? 130 : 143);
    });
  }

  // FNN children keep the event loop alive; this promise resolves only via stopAll.
  return new Promise<never>(() => {});
}

/**
 * `offckb fiber start`: launch only the FNN side of the devnet on top of an
 * already-running CKB environment. Never starts, stops or replaces CKB, the
 * miner or the RPC proxy.
 */
export async function fiberStart(version: string | undefined, options: FiberStartOptions) {
  const settings = readSettings();
  // Network/fork checks run before anything else — including before a
  // --daemon respawn, so an unsupported environment fails in the foreground.
  assertPlainDevnet(settings);

  if (options.daemon) {
    return startFiberDaemon(fiberDaemonChildArgs(), settings);
  }

  const lock = acquireEnvLock('offckb fiber start');
  try {
    await assertCkbEnvReadyForFiber(settings);

    const fnn = await resolveFnnBinary({ version, binaryPath: options.binaryPath }, settings);
    let chainScripts;
    try {
      chainScripts = resolveFiberChainScripts();
    } catch (error) {
      if (error instanceof FiberContractsMissingError) {
        logMissingContractsGuidance(error);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const env = await startFiberEnvironment({
      fnnPath: fnn.fnnPath,
      testnetConfigPath: fnn.testnetConfigPath,
      chainScripts,
      nodeCount: options.nodes,
      settings,
    });
    printFiberSummary(env);
    logger.result({
      command: 'fiber.start',
      daemon: false,
      nodes: env.nodes.map((node) => ({
        id: node.id,
        pid: node.process.pid,
        rpcUrl: node.rpcUrl,
        logFile: node.logFile,
      })),
    });
    lock.release();
    return superviseFiberNodes(env, settings);
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function fiberStopCommand() {
  const settings = readSettings();
  const lock = acquireEnvLock('offckb fiber stop');
  try {
    await stopFiber(settings);
  } finally {
    lock.release();
  }
}

export async function fiberStatusCommand() {
  await fiberStatus(readSettings());
}

export interface FiberLogsOptions {
  node: number;
  follow?: boolean;
  tail?: number;
}

export function fiberLogs(options: FiberLogsOptions) {
  const settings = readSettings();
  const nodeId = Number(options.node);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new Error('--node must be a positive integer (the node number, e.g. --node 1).');
  }
  const entries = readNodesYml(settings);
  if (entries == null || !entries.some((entry) => entry.id === nodeId)) {
    throw new Error(`Fiber node ${nodeId} does not exist (no matching entry in fiber/nodes.yml).`);
  }
  const { logFile } = fiberNodePaths(nodeId, settings);
  if (!fs.existsSync(logFile)) {
    throw new Error(`Fiber node ${nodeId} has no log yet (${logFile} has not been created).`);
  }

  const tail = options.tail ?? 100;
  for (const line of readLogTail(logFile, tail)) {
    logger.info(line);
  }
  if (options.follow) {
    followLogFile(logFile, (line) => logger.info(line));
  }
  logger.result({ command: 'fiber.logs', node: nodeId, logFile, follow: !!options.follow });
}

export async function fiberCleanCommand(options: FiberCleanOptions) {
  await fiberClean(options, readSettings());
}

// Re-exported so `node --fiber` can share the same pieces without a cycle.
export { assertPlainDevnet, resolveFnnBinary, resolveFiberChainScripts, startFiberEnvironment, FIBER_DAEMON_PID_FILE };
