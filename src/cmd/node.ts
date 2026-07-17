import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { initChainIfNeeded } from '../node/init-chain';
import { installCKBBinary } from '../node/install';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { encodeBinPathForTerminal } from '../util/encoding';
import { createRPCProxy } from '../tools/rpc-proxy';
import { markForkFirstRunComplete, readForkState } from '../devnet/fork';
import { callJsonRpc } from '../util/json-rpc';
import { Network } from '../type/base';
import { logger } from '../util/logger';

export interface NodeProp {
  version?: string;
  network?: Network;
  binaryPath?: string;
  daemon?: boolean;
}

interface PidMetadata {
  pid: number;
  scriptPath: string;
  startedAt: string;
}

const DAEMON_LOG_DIR = 'logs';
const DAEMON_LOG_FILE = 'daemon.log';
const DAEMON_PID_FILE = 'daemon.pid';
const DAEMON_CHILD_ENV = 'OFFCKB_DAEMON_CHILD';

export function startNode({ version, network = Network.devnet, binaryPath, daemon }: NodeProp) {
  if (binaryPath && network !== Network.devnet) {
    logger.warn('Custom binaryPath is only supported for devnet. The provided binaryPath will be ignored.');
  }
  if (daemon && network !== Network.devnet) {
    logger.warn('Daemon mode is only supported for devnet. The daemon flag will be ignored.');
  }

  switch (network) {
    case Network.devnet:
      return nodeDevnet({ version, binaryPath, daemon });
    case Network.testnet:
      return nodeTestnet();
    case Network.mainnet:
      return nodeMainnet();
    default:
      break;
  }
}

export async function nodeDevnet({ version, binaryPath, daemon }: NodeProp) {
  if (daemon) {
    return startDaemon();
  }

  const settings = readSettings();
  const ckbVersion = version || settings.bins.defaultCKBVersion;
  let ckbBinPath = '';

  if (binaryPath) {
    ckbBinPath = encodeBinPathForTerminal(binaryPath);
    logger.info(`Using custom CKB binary path: ${ckbBinPath}`);
  } else {
    await installCKBBinary(ckbVersion);
    ckbBinPath = encodeBinPathForTerminal(getCKBBinaryPath(ckbVersion));
  }
  await initChainIfNeeded();
  const devnetConfigPath = encodeBinPathForTerminal(settings.devnet.configPath);

  // A forked devnet must boot once with --skip-spec-check --overwrite-spec so
  // the imported (and patched) spec replaces the source chain's stored spec.
  const forkState = readForkState(settings.devnet.configPath);
  const firstRunFlags = forkState?.firstRunPending ? ' --skip-spec-check --overwrite-spec' : '';
  if (forkState?.firstRunPending) {
    logger.info(`Forked devnet (${forkState.source}) detected, first run uses --skip-spec-check --overwrite-spec.`);
  }

  const ckbCmd = `${ckbBinPath} run -C ${devnetConfigPath}${firstRunFlags}`;
  const minerCmd = `${ckbBinPath} miner -C ${devnetConfigPath}`;
  logger.info(`Launching CKB devnet Node...`);
  try {
    // Run first command
    const ckbProcess = exec(ckbCmd);
    // Log first command's output
    ckbProcess.stdout?.on('data', (data) => {
      logger.info(['CKB:', data.toString()]);
    });

    ckbProcess.stderr?.on('data', (data) => {
      logger.error(['CKB error:', data.toString()]);
    });

    if (forkState?.firstRunPending) {
      // Only clear the flag once the node is actually up; if it fails to
      // start, the next run retries with the flags again.
      void clearForkFirstRunWhenNodeUp(settings.devnet.rpcUrl, settings.devnet.configPath);
    }

    // Start the second command after 3 seconds
    setTimeout(async () => {
      try {
        // Run second command
        const minerProcess = exec(minerCmd);
        minerProcess.stdout?.on('data', (data) => {
          logger.info(['CKB-Miner:', data.toString()]);
        });
        minerProcess.stderr?.on('data', (data) => {
          logger.error(['CKB-Miner error:', data.toString()]);
        });

        // by default we start the proxy server
        const ckbRpc = settings.devnet.rpcUrl;
        const port = settings.devnet.rpcProxyPort;
        const proxy = createRPCProxy(Network.devnet, ckbRpc, port);
        proxy.start();
      } catch (error) {
        logger.error('Error running CKB-Miner:', error);
      }
    }, 3000);
  } catch (error) {
    logger.error('Error:', error);
  }
}

function resolveDaemonPaths() {
  const settings = readSettings();
  const logDir = path.join(settings.devnet.dataPath, DAEMON_LOG_DIR);
  const logFile = path.join(logDir, DAEMON_LOG_FILE);
  const pidFile = path.join(logDir, DAEMON_PID_FILE);
  return { logDir, logFile, pidFile };
}

// Poll the devnet RPC until the node answers, then mark the fork's first run
// as done so subsequent `offckb node` runs boot normally.
async function clearForkFirstRunWhenNodeUp(rpcUrl: string, configPath: string) {
  const timeoutMs = 10 * 60 * 1000; // large forks take a while to boot
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await callJsonRpc(rpcUrl, 'get_tip_block_number', [], 5000);
      markForkFirstRunComplete(configPath);
      logger.success('Forked devnet is up; first-run spec flags cleared.');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  logger.warn('Timed out waiting for the forked devnet to start; first-run flags will be retried next time.');
}

function readPidFile(pidFile: string): PidMetadata | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
  } catch (error) {
    // Treat a missing or unreadable PID file as "no daemon".
    return null;
  }

  if (!raw) {
    return null;
  }

  // Backward compatibility: plain integer PID written by older versions.
  const plainPid = Number(raw);
  if (Number.isInteger(plainPid) && plainPid > 0) {
    return { pid: plainPid, scriptPath: resolveCliEntry() ?? '', startedAt: new Date(0).toISOString() };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PidMetadata>;
    const pid = Number(parsed.pid);
    if (Number.isInteger(pid) && pid > 0 && typeof parsed.scriptPath === 'string') {
      return {
        pid,
        scriptPath: parsed.scriptPath,
        startedAt: parsed.startedAt ?? new Date(0).toISOString(),
      };
    }
  } catch {
    // fall through to sentinel below
  }

  // Content exists but is neither a valid plain PID nor valid metadata.
  // Return a sentinel so stopNode can report an invalid PID and clean up.
  return { pid: NaN, scriptPath: '', startedAt: new Date(0).toISOString() };
}

function writePidFile(pidFile: string, metadata: PidMetadata) {
  fs.writeFileSync(pidFile, JSON.stringify(metadata, null, 2));
}

function resolveCliEntry(): string | null {
  // In priority order. process.argv[1] is the most reliable for a Node CLI.
  // OFFCKB_CLI_PATH is an escape hatch for packaged/npx/weird environments.
  // require.main?.filename is a final fallback when argv is unavailable.
  const candidates = [process.env.OFFCKB_CLI_PATH, process.argv[1], require.main?.filename].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      const stats = fs.statSync(resolved);
      if (stats.isFile()) {
        return resolved;
      }
    } catch {
      // Candidate is missing or not a file; try the next one.
    }
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupPidFile(pidFile: string) {
  try {
    fs.unlinkSync(pidFile);
  } catch (error) {
    logger.warn(`Failed to remove PID file ${pidFile}:`, error);
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!isProcessAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function getProcessCommandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`wmic process where ProcessId=${pid} get CommandLine /format:list`, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const match = stdout.match(/CommandLine=(.+)/);
        resolve(match ? match[1].trim() : null);
      });
    } else {
      exec(`ps -p ${pid} -o args=`, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });
    }
  });
}

async function verifyDaemonIdentity(pid: number, metadata: PidMetadata): Promise<boolean> {
  const cmdline = await getProcessCommandLine(pid);
  if (!cmdline) {
    return false;
  }

  // The daemon child re-runs the same CLI entry point, so its command line
  // should reference the same script and should be a Node process.
  const scriptName = path.basename(metadata.scriptPath);
  const scriptDir = path.dirname(metadata.scriptPath);
  const looksLikeNode = cmdline.includes('node') || cmdline.includes('nodejs');
  const looksLikeOurScript =
    cmdline.includes(metadata.scriptPath) || (scriptName !== '' && cmdline.includes(scriptName));
  const looksLikeOffckb = cmdline.includes('offckb') || scriptDir.includes('offckb');

  return looksLikeNode && (looksLikeOurScript || looksLikeOffckb);
}

function terminateProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows has no POSIX signals and process.kill(pid) only terminates the
      // single process. Use taskkill to terminate the whole tree.
      // /T kills the process and all child processes.
      // /F forces termination when SIGKILL is requested.
      const args = signal === 'SIGKILL' ? ['/T', '/F', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
      const taskkill = spawn('taskkill', args, { stdio: 'ignore' });
      taskkill.on('error', reject);
      taskkill.on('exit', () => {
        // taskkill may return non-zero if the process is already gone, which
        // is acceptable for our purposes.
        resolve();
      });
      return;
    }

    // On POSIX, detached: true makes the child a session/process group leader.
    // A negative pid sends the signal to the entire process group, ensuring
    // the CKB node, miner and RPC proxy all receive it.
    try {
      process.kill(-pid, signal);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

function startDaemon() {
  const { logDir, logFile, pidFile } = resolveDaemonPaths();

  // Prevent duplicate daemon starts. If a daemon is already running, refuse
  // to overwrite its PID file.
  const existing = readPidFile(pidFile);
  if (existing && isProcessAlive(existing.pid)) {
    logger.error(`A CKB devnet daemon is already running (PID ${existing.pid}). Stop it first with: offckb node stop`);
    return;
  }
  if (existing && !isProcessAlive(existing.pid)) {
    // Stale PID file from a crashed daemon; clean it up before starting anew.
    cleanupPidFile(pidFile);
  }

  let out: number | undefined;
  let err: number | undefined;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    out = fs.openSync(logFile, 'a');
    err = fs.openSync(logFile, 'a');
  } catch (error) {
    logger.error(`Failed to prepare daemon log directory or log file at ${logFile}:`, error);
    return;
  }

  const scriptPath = resolveCliEntry();
  if (!scriptPath) {
    logger.error('Unable to determine the CLI entry point for daemon mode. Set OFFCKB_CLI_PATH to the offckb script.');
    closeFileDescriptors(out, err);
    return;
  }

  const childArgs = process.argv.slice(2).filter((arg) => arg !== '--daemon');
  const childEnv = { ...process.env, [DAEMON_CHILD_ENV]: '1' };

  let child;
  try {
    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      detached: true,
      stdio: ['ignore', out, err],
      env: childEnv,
    });
  } catch (error) {
    logger.error('Failed to spawn daemon process:', error);
    closeFileDescriptors(out, err);
    return;
  }

  if (!child.pid) {
    logger.error('Failed to spawn daemon process: no PID returned.');
    closeFileDescriptors(out, err);
    return;
  }

  child.unref();

  child.on('error', (error) => {
    logger.error('Daemon child process failed to start:', error);
    cleanupPidFile(pidFile);
  });

  const metadata: PidMetadata = {
    pid: child.pid,
    scriptPath,
    startedAt: new Date().toISOString(),
  };
  writePidFile(pidFile, metadata);

  // File descriptors are now owned by the spawned child; close our copies.
  closeFileDescriptors(out, err);

  logger.success(`CKB devnet daemon started with PID ${child.pid}.`);
  logger.info(`Logs: ${logFile}`);
  logger.info(`PID file: ${pidFile}`);
  logger.info('Stop the daemon with: offckb node stop');
}

function closeFileDescriptors(...fds: (number | undefined)[]) {
  for (const fd of fds) {
    if (fd === undefined) continue;
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

export async function stopNode() {
  const { pidFile } = resolveDaemonPaths();

  const metadata = readPidFile(pidFile);
  if (!metadata) {
    logger.warn(`No daemon PID file found at ${pidFile}. Is the devnet daemon running?`);
    return;
  }

  const pid = metadata.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.error(`Invalid PID in ${pidFile}: ${pid}`);
    cleanupPidFile(pidFile);
    return;
  }

  if (!isProcessAlive(pid)) {
    logger.warn(`Daemon process ${pid} is not running.`);
    cleanupPidFile(pidFile);
    return;
  }

  const identityOk = await verifyDaemonIdentity(pid, metadata);
  if (!identityOk) {
    logger.error(
      `Process ${pid} does not appear to be the offckb daemon. Refusing to send signals to avoid killing an unrelated process. ` +
        `If you are sure this is the daemon, stop it manually and remove ${pidFile}.`,
    );
    return;
  }

  logger.info(`Stopping CKB devnet daemon (PID ${pid})...`);
  try {
    await terminateProcess(pid, 'SIGTERM');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') {
      logger.warn(`Daemon process ${pid} is not running.`);
      cleanupPidFile(pidFile);
      return;
    }
    if (err.code === 'EPERM') {
      logger.error(`Permission denied when sending SIGTERM to daemon process ${pid}.`);
    } else {
      logger.error(`Failed to send SIGTERM to daemon process ${pid}:`, error);
    }
    // Still try to clean up the PID file so the user can recover.
    cleanupPidFile(pidFile);
    return;
  }

  const exited = await waitForProcessExit(pid, 5000);
  if (!exited) {
    logger.warn(`Daemon process ${pid} did not exit gracefully, sending SIGKILL...`);
    try {
      await terminateProcess(pid, 'SIGKILL');
    } catch (error) {
      logger.error(`Failed to send SIGKILL to daemon process ${pid}:`, error);
    }
  }

  cleanupPidFile(pidFile);
  logger.success('CKB devnet daemon stopped.');
}

export async function nodeTestnet() {
  // todo: maybe we can actually start a node for testnet later
  // by default we start a proxy server for testnet
  const settings = readSettings();
  const ckbRpc = settings.testnet.rpcUrl;
  const port = settings.testnet.rpcProxyPort;
  const proxy = createRPCProxy(Network.testnet, ckbRpc, port);
  proxy.start();
}

export async function nodeMainnet() {
  // todo: maybe we can actually start a node for mainnet later
  // by default we start a proxy server for mainnet
  const settings = readSettings();
  const ckbRpc = settings.mainnet.rpcUrl;
  const port = settings.mainnet.rpcProxyPort;
  const proxy = createRPCProxy(Network.mainnet, ckbRpc, port);
  proxy.start();
}
