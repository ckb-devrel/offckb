import { exec, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { initChainIfNeeded } from '../node/init-chain';
import { installCKBBinary } from '../node/install';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { createRPCProxy } from '../tools/rpc-proxy';
import { markForkFirstRunComplete, readForkState } from '../devnet/fork';
import { callJsonRpc } from '../util/json-rpc';
import { Network } from '../type/base';
import { logger } from '../util/logger';
import { checkNodeReadiness, waitForNodeReady } from '../devnet/readiness';

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
  status?: 'starting' | 'running';
}

const DAEMON_LOG_DIR = 'logs';
const DAEMON_LOG_FILE = 'daemon.log';
const DAEMON_PID_FILE = 'daemon.pid';
const DAEMON_CHILD_ENV = 'OFFCKB_DAEMON_CHILD';
const NODE_READY_TIMEOUT_MS = 90_000;
const FORK_NODE_READY_TIMEOUT_MS = 10 * 60_000;

function cleanChildOutput(data: unknown): string {
  // CKB colors its output even when it is redirected. Strip ANSI control
  // sequences so JSON logs stay machine-readable.
  return String(data).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

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
    ckbBinPath = binaryPath;
    logger.info(`Using custom CKB binary path: ${ckbBinPath}`);
  } else {
    await installCKBBinary(ckbVersion);
    ckbBinPath = getCKBBinaryPath(ckbVersion);
  }
  await initChainIfNeeded();
  const devnetConfigPath = settings.devnet.configPath;

  // A forked devnet must boot once with --skip-spec-check --overwrite-spec so
  // the imported (and patched) spec replaces the source chain's stored spec.
  const forkState = readForkState(settings.devnet.configPath);
  const firstRunFlags = forkState?.firstRunPending ? ' --skip-spec-check --overwrite-spec' : '';
  if (forkState?.firstRunPending) {
    logger.info(`Forked devnet (${forkState.source}) detected, first run uses --skip-spec-check --overwrite-spec.`);
  }

  logger.info(`Launching CKB devnet Node...`);
  const runArgs = ['run', '-C', devnetConfigPath];
  if (firstRunFlags) runArgs.push('--skip-spec-check', '--overwrite-spec');
  const ckbProcess = spawn(ckbBinPath, runArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  ckbProcess.stdout?.on('data', (data) => logger.info(['CKB:', cleanChildOutput(data)]));
  ckbProcess.stderr?.on('data', (data) => logger.error(['CKB error:', cleanChildOutput(data)]));

  let ckbExited = false;
  ckbProcess.once('exit', () => {
    ckbExited = true;
  });
  ckbProcess.once('error', () => {
    ckbExited = true;
  });

  const timeoutMs = forkState ? FORK_NODE_READY_TIMEOUT_MS : NODE_READY_TIMEOUT_MS;
  const readiness = await waitForNodeReady(settings.devnet.rpcUrl, timeoutMs, () => !ckbExited);
  if (!readiness.ready) {
    if (!ckbExited) ckbProcess.kill('SIGTERM');
    throw new Error(`CKB devnet failed to become ready: ${readiness.error ?? 'CKB process exited'}`);
  }
  if (ckbExited) {
    throw new Error('CKB devnet exited immediately after its readiness check.');
  }

  if (forkState?.firstRunPending) {
    await clearForkFirstRunWhenNodeUp(
      ckbProcess,
      settings.devnet.rpcUrl,
      settings.devnet.configPath,
      forkState.genesisHash,
    );
  }

  let minerProcess: ChildProcess;
  try {
    minerProcess = spawn(ckbBinPath, ['miner', '-C', devnetConfigPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    ckbProcess.kill('SIGTERM');
    throw new Error(`CKB miner failed to start: ${(error as Error).message}`);
  }
  minerProcess.stdout?.on('data', (data) => logger.info(['CKB-Miner:', cleanChildOutput(data)]));
  minerProcess.stderr?.on('data', (data) => logger.error(['CKB-Miner error:', cleanChildOutput(data)]));
  try {
    await waitForChildSpawn(minerProcess, 'CKB miner');
  } catch (error) {
    ckbProcess.kill('SIGTERM');
    throw error;
  }
  if (ckbExited) {
    if (!minerProcess.killed) minerProcess.kill('SIGTERM');
    throw new Error('CKB devnet exited while the miner was starting.');
  }

  const proxy = createRPCProxy(Network.devnet, settings.devnet.rpcUrl, settings.devnet.rpcProxyPort);
  proxy.start();
  logger.success(`CKB devnet is ready at ${settings.devnet.rpcUrl}.`);
  logger.result({
    command: 'node',
    network: Network.devnet,
    daemon: false,
    rpcUrl: settings.devnet.rpcUrl,
    proxyUrl: `http://127.0.0.1:${settings.devnet.rpcProxyPort}`,
  });

  // Treat CKB, miner and proxy as one service. A dead CKB must not leave a
  // healthy-looking proxy and a miner that retries forever.
  let serviceStopping = false;
  const stopService = (component: 'CKB node' | 'CKB miner', code: number | null, signal: NodeJS.Signals | null) => {
    if (serviceStopping) return;
    serviceStopping = true;
    if (component !== 'CKB node' && !ckbProcess.killed) ckbProcess.kill('SIGTERM');
    if (component !== 'CKB miner' && !minerProcess.killed) minerProcess.kill('SIGTERM');
    proxy.stop();
    if (process.env[DAEMON_CHILD_ENV] === '1') cleanupPidFile(resolveDaemonPaths().pidFile);
    logger.error(`${component} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`);
    process.exitCode = typeof code === 'number' && code > 0 ? code : 1;
  };
  ckbProcess.once('exit', (code, signal) => stopService('CKB node', code, signal));
  minerProcess.once('exit', (code, signal) => stopService('CKB miner', code, signal));
}

function waitForChildSpawn(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      reject(new Error(`${label} failed to start: ${error.message}`));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function resolveDaemonPaths() {
  const settings = readSettings();
  const logDir = path.join(settings.devnet.dataPath, DAEMON_LOG_DIR);
  const logFile = path.join(logDir, DAEMON_LOG_FILE);
  const pidFile = path.join(logDir, DAEMON_PID_FILE);
  return { logDir, logFile, pidFile };
}

// Poll the devnet RPC until the spawned node answers with the fork's genesis
// hash, then mark the first run as done so subsequent `offckb node` runs boot
// normally. Two guards against clearing the flag on the wrong signal:
//   - the poll aborts when the spawned ckb process exits (e.g. failed boot),
//   - an answering node is only trusted when its genesis matches the fork
//     state — an unrelated node occupying the port must not clear the flag.
async function clearForkFirstRunWhenNodeUp(
  ckbProcess: ChildProcess,
  rpcUrl: string,
  configPath: string,
  expectedGenesisHash: string,
) {
  let processExited = false;
  const markExited = () => {
    processExited = true;
  };
  ckbProcess.once('exit', markExited);
  ckbProcess.once('error', markExited);

  const timeoutMs = 10 * 60 * 1000; // large forks take a while to boot
  const start = Date.now();
  while (!processExited && Date.now() - start < timeoutMs) {
    try {
      const genesisHash = String(await callJsonRpc(rpcUrl, 'get_block_hash', ['0x0'], 5000)).toLowerCase();
      if (genesisHash !== expectedGenesisHash.toLowerCase()) {
        logger.warn(
          `A node is answering at ${rpcUrl} but reports a different genesis (${genesisHash}); ` +
            'leaving the first-run flags in place.',
        );
        return;
      }
      // The miner has not started yet, so this tip is the exact boundary
      // between copied public-chain state and cells mined on the local fork.
      const forkBlockNumber = BigInt(String(await callJsonRpc(rpcUrl, 'get_tip_block_number', [], 5000))).toString();
      markForkFirstRunComplete(configPath, forkBlockNumber);
      logger.success('Forked devnet is up; first-run spec flags cleared.');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (processExited) {
    logger.warn('The CKB process exited before the forked devnet came up; first-run flags will be retried next time.');
  } else {
    logger.warn('Timed out waiting for the forked devnet to start; first-run flags will be retried next time.');
  }
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
        status: parsed.status,
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

function reservePidFile(pidFile: string, scriptPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(pidFile, 'wx');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error('A CKB devnet daemon startup is already in progress. Try again after it completes.');
    }
    throw new Error(`Failed to reserve daemon PID file ${pidFile}: ${err.message}`);
  }

  let writeError: Error | undefined;
  try {
    const reservation: PidMetadata = {
      pid: process.pid,
      scriptPath,
      startedAt: new Date().toISOString(),
      status: 'starting',
    };
    fs.writeFileSync(fd, JSON.stringify(reservation, null, 2));
  } catch (error) {
    writeError = error as Error;
  } finally {
    fs.closeSync(fd);
  }
  if (writeError) {
    cleanupPidFile(pidFile);
    throw new Error(`Failed to initialize daemon PID reservation ${pidFile}: ${writeError.message}`);
  }
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
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') throw new Error(`Permission denied when checking daemon process ${pid}.`);
    throw error;
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
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (!isProcessAlive(pid)) {
          resolve(true);
          return;
        }
      } catch (error) {
        reject(error);
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

async function startDaemon() {
  const { logDir, logFile, pidFile } = resolveDaemonPaths();

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to prepare daemon log directory at ${logDir}: ${(error as Error).message}`);
  }

  const settings = readSettings();
  const activeNode = await checkNodeReadiness(settings.devnet.rpcUrl, 1000);
  if (activeNode.ready) {
    throw new Error(
      `A CKB node is already answering at ${settings.devnet.rpcUrl}. Stop it before starting daemon mode.`,
    );
  }

  // Prevent duplicate daemon starts. If a daemon is already running, refuse
  // to overwrite its PID file.
  const existing = readPidFile(pidFile);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      if (existing.status === 'starting') {
        throw new Error(`Another CKB devnet daemon startup is already in progress (PID ${existing.pid}).`);
      }
      throw new Error(
        `A CKB devnet daemon is already running (PID ${existing.pid}). Stop it first with: offckb node stop`,
      );
    }
    // Stale PID file from a crashed daemon; clean it up before atomically
    // reserving the same control file for this startup attempt.
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
    throw new Error(`Failed to prepare daemon log directory or log file at ${logFile}: ${(error as Error).message}`);
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
    closeFileDescriptors(out, err);
    cleanupPidFile(pidFile);
    throw new Error(`Failed to spawn daemon process: ${(error as Error).message}`);
  }

  if (!child.pid) {
    closeFileDescriptors(out, err);
    cleanupPidFile(pidFile);
    throw new Error('Failed to spawn daemon process: no PID returned.');
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
    status: 'running',
  };
  writePidFile(pidFile, metadata);

  // File descriptors are now owned by the spawned child; close our copies.
  closeFileDescriptors(out, err);

  const forkState = readForkState(settings.devnet.configPath);
  const timeoutMs = forkState ? FORK_NODE_READY_TIMEOUT_MS : NODE_READY_TIMEOUT_MS;
  // The proxy only starts after the child has a healthy CKB RPC and has
  // successfully spawned the miner, so this is the daemon's service-level
  // readiness check rather than a port/process check.
  const proxyUrl = `http://127.0.0.1:${settings.devnet.rpcProxyPort}`;
  const readiness = await waitForNodeReady(proxyUrl, timeoutMs, () => isProcessAlive(child.pid!));
  if (!readiness.ready) {
    let exited = !isProcessAlive(child.pid);
    try {
      if (!exited) {
        await terminateProcess(child.pid, 'SIGTERM');
        exited = await waitForProcessExit(child.pid, 5000);
        if (!exited) {
          await terminateProcess(child.pid, 'SIGKILL');
          exited = await waitForProcessExit(child.pid, 5000);
        }
      }
    } catch {
      // The failed child may already have exited while signals were sent.
      exited = !isProcessAlive(child.pid);
    }
    if (exited) {
      cleanupPidFile(pidFile);
    }
    throw new Error(
      `CKB devnet daemon failed to become ready. See ${logFile}. ${readiness.error ?? 'Daemon process exited.'}` +
        (exited ? '' : ` Process ${child.pid} is still running; PID file was preserved.`),
    );
  }

  logger.success(`CKB devnet daemon started with PID ${child.pid} and passed its RPC/proxy health check.`);
  logger.info(`Logs: ${logFile}`);
  logger.info(`PID file: ${pidFile}`);
  logger.info('Stop the daemon with: offckb node stop');
  logger.result({
    command: 'node',
    network: Network.devnet,
    daemon: true,
    pid: child.pid,
    rpcUrl: settings.devnet.rpcUrl,
    proxyUrl,
    logFile,
    pidFile,
  });
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
    logger.result({ command: 'node.stop', stopped: false, reason: 'not-running' });
    return;
  }

  const pid = metadata.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    cleanupPidFile(pidFile);
    throw new Error(`Invalid PID in ${pidFile}: ${pid}`);
  }

  const processAlive = isProcessAlive(pid);
  if (!processAlive) {
    logger.warn(`Daemon process ${pid} is not running.`);
    cleanupPidFile(pidFile);
    logger.result({ command: 'node.stop', stopped: false, reason: 'stale-pid', pid });
    return;
  }
  if (metadata.status === 'starting') {
    throw new Error(`CKB devnet daemon startup is still in progress (PID ${pid}). Try stopping it again shortly.`);
  }

  const identityOk = await verifyDaemonIdentity(pid, metadata);
  if (!identityOk) {
    throw new Error(
      `Process ${pid} does not appear to be the offckb daemon. Refusing to send signals to avoid killing an unrelated process. ` +
        `If you are sure this is the daemon, stop it manually and remove ${pidFile}.`,
    );
  }

  logger.info(`Stopping CKB devnet daemon (PID ${pid})...`);
  try {
    await terminateProcess(pid, 'SIGTERM');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') {
      logger.warn(`Daemon process ${pid} is not running.`);
      cleanupPidFile(pidFile);
      logger.result({ command: 'node.stop', stopped: false, reason: 'already-exited', pid });
      return;
    }
    if (err.code === 'EPERM') {
      throw new Error(`Permission denied when sending SIGTERM to daemon process ${pid}.`);
    }
    throw new Error(`Failed to send SIGTERM to daemon process ${pid}: ${err.message}`);
  }

  const exited = await waitForProcessExit(pid, 5000);
  if (!exited) {
    logger.warn(`Daemon process ${pid} did not exit gracefully, sending SIGKILL...`);
    try {
      await terminateProcess(pid, 'SIGKILL');
    } catch (error) {
      throw new Error(`Failed to send SIGKILL to daemon process ${pid}: ${(error as Error).message}`);
    }
  }

  cleanupPidFile(pidFile);
  logger.success('CKB devnet daemon stopped.');
  logger.result({ command: 'node.stop', stopped: true, pid });
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
