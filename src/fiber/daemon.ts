import { spawn } from 'child_process';
import * as fs from 'fs';
import {
  cleanupPidFile,
  closeFileDescriptors,
  isProcessAlive,
  nodeDaemonPaths,
  readPidFile,
  reservePidFile,
  resolveCliEntry,
  terminateProcess,
  verifyDaemonIdentity,
  waitForProcessExit,
  writePidFile,
  PidMetadata,
} from '../util/daemon';
import { fiberDaemonPaths, fiberNodePaths } from './paths';
import { readRuntime, readLiveRuntime, isRuntimeStale, removeRuntimeFile } from './runtime';
import { isStoreLockHeld, waitForStoreLocksReleased } from './store-lock';
import { readSettings, Settings } from '../cfg/setting';
import { logger } from '../util/logger';

const FIBER_DAEMON_CHILD_ENV = 'OFFCKB_DAEMON_CHILD';
// First run may download FNN. Exported: the `node --fiber --daemon` readiness
// wait in cmd/node.ts must use exactly this value.
export const FIBER_DAEMON_READY_TIMEOUT_MS = 10 * 60_000;
// The launcher flips a 'starting' PID record to 'running' within the ready
// timeout (or deletes it on failure). Beyond this grace window a 'starting'
// record means the launcher died mid-startup and the record is stoppable.
const FIBER_DAEMON_STARTUP_GRACE_MS = FIBER_DAEMON_READY_TIMEOUT_MS + 60_000;
const STOP_WAIT_TIMEOUT_MS = 15_000;
const STORE_LOCK_WAIT_TIMEOUT_MS = 15_000;

/**
 * Daemonize `fiber start`: the current command spawns a detached manager
 * child re-running the same command without --daemon, waits until the child
 * reports a running environment in runtime.json, then exits. The child keeps
 * managing all FNNs; `offckb fiber stop` signals it later.
 */
export async function startFiberDaemon(childArgs: string[], settings: Settings = readSettings()) {
  const { logDir, logFile, pidFile } = fiberDaemonPaths(settings);
  fs.mkdirSync(logDir, { recursive: true });

  const existing = readPidFile(pidFile);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      const identityOk = await verifyDaemonIdentity(existing.pid, existing);
      if (identityOk) {
        if (existing.status === 'starting') {
          throw new Error(`Another fiber daemon startup is already in progress (PID ${existing.pid}).`);
        }
        throw new Error(
          `A fiber daemon is already running (PID ${existing.pid}). Stop it first with: offckb fiber stop`,
        );
      }
      // Fail closed: a live process whose identity cannot be verified keeps
      // its metadata. Replacing it would strand a possibly-running daemon with
      // no PID record for stop/status/clean to find, and the replacement
      // child would die at the environment lock anyway.
      throw new Error(
        `PID ${existing.pid} from ${pidFile} is alive but does not look like the offckb fiber daemon. ` +
          `Refusing to replace its metadata. If that process is unrelated, stop it manually and remove ${pidFile}.`,
      );
    }
    cleanupPidFile(pidFile);
  }

  const scriptPath = resolveCliEntry();
  if (!scriptPath) {
    throw new Error(
      'Unable to determine the CLI entry point for daemon mode. Set OFFCKB_CLI_PATH to the offckb script.',
    );
  }
  reservePidFile(pidFile, scriptPath);

  let out: number | undefined;
  let err: number | undefined;
  try {
    out = fs.openSync(logFile, 'a');
    err = fs.openSync(logFile, 'a');
  } catch (error) {
    closeFileDescriptors(out, err);
    cleanupPidFile(pidFile);
    throw new Error(`Failed to prepare daemon log file at ${logFile}: ${(error as Error).message}`);
  }

  const childEnv = { ...process.env, [FIBER_DAEMON_CHILD_ENV]: '1' };
  let child;
  try {
    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      detached: true,
      stdio: ['ignore', out, err],
      env: childEnv,
    });
  } catch (error) {
    closeFileDescriptors(out, err);
    cleanupPidFile(pidFile);
    throw new Error(`Failed to spawn fiber daemon process: ${(error as Error).message}`);
  }
  if (!child.pid) {
    closeFileDescriptors(out, err);
    cleanupPidFile(pidFile);
    throw new Error('Failed to spawn fiber daemon process: no PID returned.');
  }
  child.unref();
  child.on('error', (error) => {
    logger.error('Fiber daemon child process failed to start:', error);
    cleanupPidFile(pidFile);
  });

  const metadata: PidMetadata = {
    pid: child.pid,
    scriptPath,
    startedAt: new Date().toISOString(),
    status: 'starting',
  };
  try {
    writePidFile(pidFile, metadata);
  } catch (error) {
    closeFileDescriptors(out, err);
    return failFiberDaemonStartup(error as Error, child.pid, pidFile);
  }
  closeFileDescriptors(out, err);

  // Readiness: the child records a running environment in runtime.json only
  // after every startup check has passed.
  const start = Date.now();
  let ready = false;
  while (!ready && Date.now() - start < FIBER_DAEMON_READY_TIMEOUT_MS) {
    if (!isProcessAlive(child.pid)) {
      return failFiberDaemonStartup(
        new Error(`Fiber daemon exited before the environment became ready. See ${logFile}.`),
        child.pid,
        pidFile,
      );
    }
    const runtime = readRuntime(settings);
    if (runtime && runtime.managerPid === child.pid && runtime.status === 'running') {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    return failFiberDaemonStartup(
      new Error(`Timed out waiting for the fiber environment to become ready. See ${logFile}.`),
      child.pid,
      pidFile,
    );
  }
  writePidFile(pidFile, { ...metadata, status: 'running' });

  logger.success(`Fiber daemon started with PID ${child.pid}; all startup checks passed.`);
  logger.info(`Logs: ${logFile}`);
  logger.info(`PID file: ${pidFile}`);
  logger.info('Stop the daemon with: offckb fiber stop');
  logger.result({ command: 'fiber.start', daemon: true, pid: child.pid, logFile, pidFile });
}

async function failFiberDaemonStartup(error: Error, pid: number, pidFile: string): Promise<never> {
  let exited = false;
  try {
    exited = !isProcessAlive(pid);
    if (!exited) {
      await terminateProcess(pid, 'SIGTERM');
      exited = await waitForProcessExit(pid, 5000);
      if (!exited) {
        await terminateProcess(pid, 'SIGKILL');
        exited = await waitForProcessExit(pid, 5000);
      }
    }
  } catch {
    try {
      exited = !isProcessAlive(pid);
    } catch {
      exited = false;
    }
  }

  if (exited) {
    cleanupPidFile(pidFile);
  } else {
    error.message += ` Process ${pid} is still running; PID file was preserved.`;
  }
  throw error;
}

function storeLockFilesForRuntime(settings: Settings): string[] {
  const runtime = readRuntime(settings);
  if (!runtime) return [];
  return runtime.nodes.map((node) => fiberNodePaths(node.id, settings).storeLockFile);
}

async function stopManagerAndCleanup(options: {
  pid: number;
  pidFile: string | null;
  label: string;
  settings: Settings;
}): Promise<'stopped' | 'unconfirmed'> {
  const { pid, pidFile, label, settings } = options;
  // Capture the node lock files while runtime.json still exists; the manager
  // removes it during its own shutdown.
  const lockFiles = storeLockFilesForRuntime(settings);
  logger.info(`Stopping ${label} (PID ${pid}); its FNN nodes stop with it...`);
  await terminateProcess(pid, 'SIGTERM');
  const exited = await waitForProcessExit(pid, STOP_WAIT_TIMEOUT_MS);

  let locksReleased = await waitForStoreLocksReleased(lockFiles, STORE_LOCK_WAIT_TIMEOUT_MS);
  if (!exited || !locksReleased) {
    logger.warn(`${label} or its FNN nodes did not finish stopping in time; sending SIGKILL once...`);
    try {
      await terminateProcess(pid, 'SIGKILL');
    } catch {
      // the process group may already be gone
    }
    await waitForProcessExit(pid, 5000);
    locksReleased = await waitForStoreLocksReleased(lockFiles, 5000);
  }
  if (!locksReleased) {
    const held = lockFiles.filter((file) => isStoreLockHeld(file) !== false);
    logger.warn(
      `Could not confirm all Fiber store locks were released (${held.join(', ') || 'unknown'}). ` +
        'Check for leftover fnn processes before starting Fiber again.',
    );
  }

  // Only a confirmed-gone manager loses its ownership records. While the
  // process may still be alive, the PID file and runtime.json are the only
  // way later commands (fiber stop, node stop, clean) can see the
  // environment — deleting them would strand running FNNs.
  let managerGone: boolean;
  try {
    managerGone = !isProcessAlive(pid);
  } catch {
    managerGone = false; // liveness unverifiable → treat as possibly alive
  }
  if (!managerGone) {
    logger.warn(
      `${label} (PID ${pid}) could not be confirmed stopped; keeping its PID file and runtime.json so ` +
        'later commands still see the environment. Stop it manually before starting Fiber again.',
    );
    return 'unconfirmed';
  }
  if (pidFile) cleanupPidFile(pidFile);
  removeRuntimeFile(settings);
  return 'stopped';
}

/**
 * Guard for `node stop`: a live fiber environment managed by a process OTHER
 * than the CKB daemon being stopped (a foreground `fiber start` or
 * `node --fiber` terminal) would keep running on a chain that no longer
 * exists. Refuse the stop unless the caller explicitly forces it. When the
 * fiber manager IS the CKB daemon being stopped (`node --fiber --daemon`),
 * stopping it stops the FNNs with it — nothing is orphaned.
 */
export function assertNodeStopDoesNotOrphanFiber(
  options: { ckbDaemonPid: number; force?: boolean },
  settings: Settings = readSettings(),
): void {
  const runtime = readLiveRuntime(settings);
  if (runtime == null || runtime.managerPid === options.ckbDaemonPid) return;
  if (options.force) {
    logger.warn(
      `Fiber nodes managed by OffCKB process ${runtime.managerPid} will keep running on a stopped chain (--force). ` +
        'Stop them afterwards: Ctrl+C in that terminal, or `offckb fiber stop` if it is a fiber daemon.',
    );
    return;
  }
  throw new Error(
    `Fiber nodes are managed by a foreground OffCKB process (PID ${runtime.managerPid}). ` +
      'Stopping the CKB daemon would orphan them on a stopped chain. ' +
      'Stop them first (Ctrl+C in that terminal), or override with: offckb node stop --force',
  );
}

/**
 * Stop daemon-managed FNNs. Only manager processes recorded in a daemon PID
 * file are ever signaled: the fiber daemon of `fiber start --daemon`, or the
 * CKB daemon of `node --fiber --daemon` (which manages CKB and FNNs as one
 * group, so stopping it stops the whole environment). Foreground managers
 * are reported, never signaled. FNNs are never killed individually by
 * runtime.json, port, path or version.
 */
export async function stopFiber(settings: Settings = readSettings()) {
  const { pidFile } = fiberDaemonPaths(settings);

  const fiberDaemon = readPidFile(pidFile);
  if (fiberDaemon && Number.isInteger(fiberDaemon.pid) && fiberDaemon.pid > 0) {
    if (isProcessAlive(fiberDaemon.pid)) {
      if (fiberDaemon.status === 'starting') {
        // A genuine startup finishes (or fails and deletes the record) within
        // the ready timeout. A 'starting' record older than that means the
        // launcher was interrupted mid-startup; fall through to identity
        // verification instead of deadlocking stop and clean forever.
        const startedAtMs = Date.parse(fiberDaemon.startedAt ?? '');
        const withinStartupWindow =
          Number.isFinite(startedAtMs) && Date.now() - startedAtMs <= FIBER_DAEMON_STARTUP_GRACE_MS;
        if (withinStartupWindow) {
          throw new Error(
            `The fiber daemon startup is still in progress (PID ${fiberDaemon.pid}). Try stopping it again shortly.`,
          );
        }
        logger.warn(
          `The fiber daemon (PID ${fiberDaemon.pid}) has been 'starting' beyond the startup window; ` +
            'its launcher appears to have exited. Verifying its identity before stopping it.',
        );
      }
      const identityOk = await verifyDaemonIdentity(fiberDaemon.pid, fiberDaemon);
      if (!identityOk) {
        throw new Error(
          `Process ${fiberDaemon.pid} does not appear to be the offckb fiber daemon. Refusing to signal it. ` +
            `If you are sure, stop it manually and remove ${pidFile}.`,
        );
      }
      const outcome = await stopManagerAndCleanup({ pid: fiberDaemon.pid, pidFile, label: 'fiber daemon', settings });
      if (outcome === 'stopped') {
        logger.success('Fiber daemon stopped.');
        logger.result({ command: 'fiber.stop', stopped: true, pid: fiberDaemon.pid });
      } else {
        logger.result({ command: 'fiber.stop', stopped: false, reason: 'stop-unconfirmed', pid: fiberDaemon.pid });
      }
      return;
    }
    logger.warn(`Fiber daemon process ${fiberDaemon.pid} is not running; removing the stale PID file.`);
    cleanupPidFile(pidFile);
  } else if (fiberDaemon) {
    cleanupPidFile(pidFile);
  }

  // No fiber daemon. The FNNs may belong to a `node --fiber --daemon`
  // environment, whose CKB daemon manages CKB and FNNs as one group.
  const runtime = readLiveRuntime(settings);
  if (runtime == null) {
    const stale = readRuntime(settings);
    if (stale && isRuntimeStale(stale)) {
      removeRuntimeFile(settings);
      logger.warn(
        `The fiber manager process ${stale.managerPid} has already exited. ` +
          'If any FNN processes outlived it they are now unmanaged; stop them manually.',
      );
      logger.result({ command: 'fiber.stop', stopped: false, reason: 'stale-runtime' });
      return;
    }
    logger.info('No running fiber environment found.');
    logger.result({ command: 'fiber.stop', stopped: false, reason: 'not-running' });
    return;
  }

  const nodeDaemon = readPidFile(nodeDaemonPaths(settings).pidFile);
  if (
    nodeDaemon &&
    Number.isInteger(nodeDaemon.pid) &&
    nodeDaemon.pid === runtime.managerPid &&
    isProcessAlive(nodeDaemon.pid)
  ) {
    const identityOk = await verifyDaemonIdentity(nodeDaemon.pid, nodeDaemon);
    if (!identityOk) {
      throw new Error(`Process ${nodeDaemon.pid} does not appear to be the offckb node daemon. Refusing to signal it.`);
    }
    logger.warn(
      'The FNN nodes are managed by the `offckb node --fiber --daemon` manager; ' +
        'stopping it stops the whole environment (CKB, miner, RPC proxy and FNNs).',
    );
    const outcome = await stopManagerAndCleanup({
      pid: nodeDaemon.pid,
      pidFile: nodeDaemonPaths(settings).pidFile,
      label: 'node --fiber daemon',
      settings,
    });
    if (outcome === 'stopped') {
      logger.success('The node --fiber environment (CKB and FNNs) stopped.');
      logger.result({ command: 'fiber.stop', stopped: true, pid: nodeDaemon.pid, includedCkb: true });
    } else {
      logger.result({ command: 'fiber.stop', stopped: false, reason: 'stop-unconfirmed', pid: nodeDaemon.pid });
    }
    return;
  }

  logger.warn(
    `The FNN nodes are managed by a foreground OffCKB process (PID ${runtime.managerPid}). ` +
      'Stop it with Ctrl+C in the terminal where it is running.',
  );
  logger.result({ command: 'fiber.stop', stopped: false, reason: 'foreground-manager', pid: runtime.managerPid });
}
