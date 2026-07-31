import { execFileSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  initChainIfNeeded,
  devnetConfigHasTerminalRpc,
  supportsTerminalRpcModule,
  TERMINAL_RPC_MIN_CKB_VERSION,
} from '../node/init-chain';
import { getVersionFromBinary, installCKBBinary } from '../node/install';
import { getCKBBinaryPath, readSettings, Settings } from '../cfg/setting';
import { createRPCProxy } from '../tools/rpc-proxy';
import { markForkFirstRunComplete, readForkState } from '../devnet/fork';
import { callJsonRpc } from '../util/json-rpc';
import { Network } from '../type/base';
import { logger } from '../util/logger';
import { checkNodeReadiness, waitForNodeReady } from '../devnet/readiness';
import { devnetTcpListenAddress, subscribeToNodeLogs, SubscriptionHandle } from '../devnet/log-subscription';
import { SCRIPT_LOG_TARGET } from '../devnet/log-file';
import {
  cleanupPidFile,
  closeFileDescriptors,
  isProcessAlive,
  nodeDaemonPaths,
  PidMetadata,
  readPidFile,
  reservePidFile,
  resolveCliEntry,
  terminateProcess,
  verifyDaemonIdentity,
  waitForProcessExit,
  writePidFile,
} from '../util/daemon';
import { assertPlainDevnet } from '../fiber/ckb-env';
import { acquireEnvLock, EnvLockHandle } from '../fiber/env-lock';
import { resolveFnnBinary, ResolvedFnn } from '../fiber/install';
import { resolveFiberChainScripts } from '../fiber/scripts';
import { FiberEnvironment, startFiberEnvironment, stopFiberNodes } from '../fiber/manager';
import { printFiberSummary } from './fiber';
import { readLiveRuntime, readRuntime } from '../fiber/runtime';
import { fiberDaemonPaths } from '../fiber/paths';

export interface NodeProp {
  version?: string;
  network?: Network;
  binaryPath?: string;
  daemon?: boolean;
  verbose?: boolean;
  fiber?: boolean;
  fnnVersion?: string;
  fiberNodes?: number;
  fnnBinaryPath?: string;
}

const DAEMON_CHILD_ENV = 'OFFCKB_DAEMON_CHILD';
const NODE_READY_TIMEOUT_MS = 90_000;
const FORK_NODE_READY_TIMEOUT_MS = 10 * 60_000;

function cleanChildOutput(data: unknown): string {
  // CKB colors its output even when it is redirected, and log text relayed
  // from the node (including contract debug! messages) is untrusted terminal
  // input. Strip ANSI CSI/OSC sequences and C0/C1 control characters (keeping
  // \n and \t) so JSON logs stay machine-readable and a crafted script log
  // cannot inject terminal control sequences.
  return String(data)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function startNode({
  version,
  network = Network.devnet,
  binaryPath,
  daemon,
  verbose,
  fiber,
  fnnVersion,
  fiberNodes,
  fnnBinaryPath,
}: NodeProp) {
  if (binaryPath && network !== Network.devnet) {
    logger.warn('Custom binaryPath is only supported for devnet. The provided binaryPath will be ignored.');
  }
  if (daemon && network !== Network.devnet) {
    logger.warn('Daemon mode is only supported for devnet. The daemon flag will be ignored.');
  }

  if (fiber) {
    if (network !== Network.devnet) {
      throw new Error(`--fiber is only supported on the plain local devnet; --network ${network} cannot be used.`);
    }
    // A forked devnet is rejected before any daemon respawn, so an
    // unsupported environment always fails in the foreground.
    assertPlainDevnet(readSettings());
  }

  switch (network) {
    case Network.devnet:
      return nodeDevnet({ version, binaryPath, daemon, verbose, fiber, fnnVersion, fiberNodes, fnnBinaryPath });
    case Network.testnet:
      return nodeTestnet();
    case Network.mainnet:
      return nodeMainnet();
    default:
      break;
  }
}

export async function nodeDevnet(props: NodeProp) {
  const { daemon, fiber } = props;
  if (daemon) {
    return startDaemon(!!fiber);
  }

  const settings = readSettings();
  // --fiber shares the devnet environment with the fiber commands, so it
  // takes the same environment lock before mutating anything, and refuses to
  // adopt an already-running CKB (use `offckb fiber start` for that).
  let envLock: EnvLockHandle | null = null;
  if (fiber) {
    const occupied = await checkNodeReadiness(settings.devnet.rpcUrl, 1000);
    if (occupied.ready) {
      throw new Error(
        `A CKB node is already answering at ${settings.devnet.rpcUrl}. OffCKB does not take over a node it did not start; ` +
          'add FNN nodes to it with: offckb fiber start',
      );
    }
    envLock = acquireEnvLock('offckb node --fiber');
  }
  try {
    return await runNodeDevnet(props, envLock, settings);
  } catch (error) {
    envLock?.release();
    throw error;
  }
}

async function runNodeDevnet(
  { version, binaryPath, verbose, fiber, fnnVersion, fiberNodes, fnnBinaryPath }: NodeProp,
  envLock: EnvLockHandle | null,
  settings: Settings,
) {
  const ckbVersion = version || settings.bins.defaultCKBVersion;

  let ckbBinPath = '';
  // The version the chain config will be validated against. A managed binary
  // knows its version by construction; a custom --binary-path is probed, and
  // an unprobeable binary stays null (unknown → assume Terminal-capable).
  let effectiveCkbVersion: string | null = null;

  if (binaryPath) {
    ckbBinPath = binaryPath;
    logger.info(`Using custom CKB binary path: ${ckbBinPath}`);
    effectiveCkbVersion = getVersionFromBinary(ckbBinPath);
  } else {
    await installCKBBinary(ckbVersion);
    ckbBinPath = getCKBBinaryPath(ckbVersion);
    effectiveCkbVersion = ckbVersion;
  }
  await initChainIfNeeded({ ckbVersion: effectiveCkbVersion });
  const devnetConfigPath = settings.devnet.configPath;

  // A config that enables the Terminal RPC module crashes CKB < 0.205.0 at
  // startup with an opaque serde error ("unknown variant `Terminal`"). Catch
  // that combination before spawning and say what is actually wrong. The
  // version-aware init above never *adds* Terminal for such a binary, so
  // hitting this means the config genuinely predates/downgraded past us.
  if (!supportsTerminalRpcModule(effectiveCkbVersion) && devnetConfigHasTerminalRpc(devnetConfigPath)) {
    throw new Error(
      `The devnet config (${path.join(devnetConfigPath, 'ckb.toml')}) enables the "Terminal" RPC module, ` +
        `which requires CKB >= ${TERMINAL_RPC_MIN_CKB_VERSION}; the selected binary is ${effectiveCkbVersion}. ` +
        `Upgrade the CKB version or remove "Terminal" from rpc.modules in that file.`,
    );
  }
  if (!supportsTerminalRpcModule(effectiveCkbVersion)) {
    logger.info(
      `CKB ${effectiveCkbVersion} predates the Terminal RPC module; ` +
        `the system-metric panels of \`offckb status\` require CKB >= ${TERMINAL_RPC_MIN_CKB_VERSION}.`,
    );
  }

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
  // Quiet by default: the node keeps its full log in data/logs/run.log
  // (see `offckb logs`), and contract script debug output streams over the
  // TCP log subscription below. --verbose restores the raw stdout/stderr relay.
  // stdout must be drained either way or the child blocks on a full pipe
  // buffer once the OS pipe fills.
  if (verbose) {
    ckbProcess.stdout?.on('data', (data) => logger.info(['CKB:', cleanChildOutput(data)]));
  } else {
    ckbProcess.stdout?.on('data', () => {});
  }
  // Keep a bounded stderr tail so a startup crash can be translated into an
  // actionable error below (CKB's own config errors are notoriously opaque).
  let ckbStderrTail = '';
  ckbProcess.stderr?.on('data', (data) => {
    const text = cleanChildOutput(data);
    ckbStderrTail = (ckbStderrTail + text).slice(-4096);
    if (verbose) logger.error(['CKB error:', text]);
  });

  let ckbExited = false;
  ckbProcess.once('exit', () => {
    ckbExited = true;
  });
  ckbProcess.once('error', () => {
    ckbExited = true;
  });

  // With --fiber, FNN selection/download starts as soon as CKB begins to
  // start, so it overlaps with the devnet readiness wait below.
  let fnnPrep: Promise<ResolvedFnn> | null = null;
  if (fiber) {
    fnnPrep = resolveFnnBinary({ version: fnnVersion, binaryPath: fnnBinaryPath }, settings);
    fnnPrep.catch(() => {
      // surfaced when awaited after the CKB environment is ready
    });
  }

  const timeoutMs = forkState ? FORK_NODE_READY_TIMEOUT_MS : NODE_READY_TIMEOUT_MS;
  const readiness = await waitForNodeReady(settings.devnet.rpcUrl, timeoutMs, () => !ckbExited);
  if (!readiness.ready) {
    if (!ckbExited) ckbProcess.kill('SIGTERM');
    const hint = terminalRpcUnknownVariantHint(ckbStderrTail, devnetConfigPath);
    throw new Error(
      `CKB devnet failed to become ready: ${readiness.error ?? 'CKB process exited'}${hint ?? ''} ` +
        'Check the node log with `offckb logs` or rerun with --verbose for full output.',
    );
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
  if (verbose) {
    minerProcess.stdout?.on('data', (data) => logger.info(['CKB-Miner:', cleanChildOutput(data)]));
    minerProcess.stderr?.on('data', (data) => logger.error(['CKB-Miner error:', cleanChildOutput(data)]));
  } else {
    minerProcess.stdout?.on('data', () => {});
    minerProcess.stderr?.on('data', () => {});
  }
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

  const proxy = createRPCProxy(Network.devnet, settings.devnet.rpcUrl, settings.devnet.rpcProxyPort, { verbose });
  proxy.start();

  // Contract script debug output (debug! in scripts) streams live over the
  // node's TCP log subscription; everything else stays in the log files.
  let logSubscription: SubscriptionHandle | null = null;
  const tcpAddress = devnetTcpListenAddress();
  if (tcpAddress) {
    logSubscription = subscribeToNodeLogs(
      tcpAddress,
      (entry) => {
        if (entry.target === SCRIPT_LOG_TARGET) logger.info(['CKB-Script:', cleanChildOutput(entry.message)]);
      },
      (error) => logger.warn(`${error.message} Full logs remain available via: offckb logs -f`),
    );
  } else if (!verbose) {
    logger.debug('No tcp_listen_address in ckb.toml; script debug output will not stream live.');
  }

  logger.success(`CKB devnet is ready at ${settings.devnet.rpcUrl}.`);
  if (!verbose) {
    logger.info('Follow the full node log with: offckb logs -f');
  }

  // The CKB environment is up. With --fiber, wait for the FNN binary
  // preparation (started above, concurrent with CKB startup) and run the
  // shared Fiber startup flow. Any failure stops everything started here.
  let fiberEnv: FiberEnvironment | null = null;
  if (fiber && fnnPrep) {
    const stopStartedProcesses = () => {
      logSubscription?.close();
      if (!ckbProcess.killed) ckbProcess.kill('SIGTERM');
      if (!minerProcess.killed) minerProcess.kill('SIGTERM');
      proxy.stop();
      envLock?.release();
    };
    try {
      const fnn = await fnnPrep;
      fiberEnv = await startFiberEnvironment({
        fnnPath: fnn.fnnPath,
        testnetConfigPath: fnn.testnetConfigPath,
        chainScripts: resolveFiberChainScripts(),
        nodeCount: fiberNodes,
        settings,
      });
    } catch (error) {
      stopStartedProcesses();
      throw error;
    }
    printFiberSummary(fiberEnv);
    // The environment is built; further mutations by other OffCKB processes
    // (stop/clean) check the manager records instead of the lock.
    envLock?.release();
    envLock = null;
  }

  logger.result({
    command: 'node',
    network: Network.devnet,
    daemon: false,
    rpcUrl: settings.devnet.rpcUrl,
    proxyUrl: `http://127.0.0.1:${settings.devnet.rpcProxyPort}`,
    ...(fiberEnv
      ? { fiber: fiberEnv.nodes.map((node) => ({ id: node.id, pid: node.process.pid, rpcUrl: node.rpcUrl })) }
      : {}),
  });

  // Treat CKB, miner, proxy and the FNNs as one service. A dead component
  // must not leave the rest looking healthy.
  let serviceStopping = false;
  const stopService = (component: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (serviceStopping) return;
    serviceStopping = true;
    void (async () => {
      logSubscription?.close();
      if (component !== 'CKB node' && !ckbProcess.killed) ckbProcess.kill('SIGTERM');
      if (component !== 'CKB miner' && !minerProcess.killed) minerProcess.kill('SIGTERM');
      proxy.stop();
      if (fiberEnv) {
        await stopFiberNodes(fiberEnv.nodes, settings);
      }
      if (process.env[DAEMON_CHILD_ENV] === '1') cleanupPidFile(resolveDaemonPaths().pidFile);
      envLock?.release();
      logger.error(`${component} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`);
      process.exitCode = typeof code === 'number' && code > 0 ? code : 1;
    })();
  };
  ckbProcess.once('exit', (code, signal) => stopService('CKB node', code, signal));
  minerProcess.once('exit', (code, signal) => stopService('CKB miner', code, signal));
  if (fiberEnv) {
    for (const node of fiberEnv.nodes) {
      node.process.once('exit', (code, signal) => stopService(`FNN node ${node.id}`, code, signal));
    }
    installFiberSignalHandlers(ckbProcess, minerProcess, proxy, fiberEnv, settings);
  }
}

// With --fiber the process group contains FNNs whose runtime.json should not
// outlive a clean shutdown. Stop the whole group on Ctrl+C/SIGTERM instead of
// letting each process fend for itself.
function installFiberSignalHandlers(
  ckbProcess: ChildProcess,
  minerProcess: ChildProcess,
  proxy: { stop: () => void },
  fiberEnv: FiberEnvironment,
  settings: Settings,
) {
  let handling = false;
  const handler = (signal: 'SIGINT' | 'SIGTERM') => {
    if (handling) return;
    handling = true;
    void (async () => {
      logger.info(`Received ${signal}, stopping the devnet and fiber nodes...`);
      if (!ckbProcess.killed) ckbProcess.kill('SIGTERM');
      if (!minerProcess.killed) minerProcess.kill('SIGTERM');
      proxy.stop();
      await stopFiberNodes(fiberEnv.nodes, settings);
      if (process.env[DAEMON_CHILD_ENV] === '1') cleanupPidFile(resolveDaemonPaths().pidFile);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}

// CKB < 0.205.0 rejects the Terminal RPC module during config deserialization
// with a serde "unknown variant `Terminal`" error and exits. When startup
// fails with that signature — the realistic case being a custom --binary-path
// whose version could not be probed — point at the actual cause instead of
// leaving the user with the raw serde message.
export function terminalRpcUnknownVariantHint(stderrTail: string, devnetConfigPath: string): string | null {
  if (!/unknown variant [`'"]?Terminal/.test(stderrTail)) return null;
  return (
    ` The "Terminal" RPC module requires CKB >= ${TERMINAL_RPC_MIN_CKB_VERSION}; ` +
    `remove "Terminal" from rpc.modules in ${path.join(devnetConfigPath, 'ckb.toml')} or use a newer CKB binary.`
  );
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
  return nodeDaemonPaths(readSettings());
}

// Best-effort check that the spawned process is the one listening on the RPC
// port. Returns null when the check cannot be performed (Windows, no lsof, an
// lsof inspection error, or a hung lsof that hits the timeout) so callers can
// fall back to weaker signals.
// lsof exits 1 both for "no match" and for permission/inspection errors; only
// an empty stderr is a genuine no-match, anything else is indeterminate. A
// timed-out probe is killed with an empty stderr too, so ETIMEDOUT must be
// ruled out first to avoid misreading it as a genuine no-match.
export function isProcessListeningOnPort(pid: number, port: number): boolean | null {
  if (process.platform === 'win32') return null;
  try {
    execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP:' + port, '-sTCP:LISTEN'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (err.code === 'ENOENT' || err.code === 'ETIMEDOUT') return null;
    const stderr = err.stderr?.toString().trim() ?? '';
    return stderr === '' ? false : null;
  }
}

function rpcPortOf(rpcUrl: string): number | null {
  try {
    const url = new URL(rpcUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

// Poll the devnet RPC until the spawned node answers with the fork's genesis
// hash, then mark the first run as done so subsequent `offckb node` runs boot
// normally. Guards against clearing the flag on the wrong signal:
//   - the poll aborts when the spawned ckb process exits (e.g. failed boot),
//   - an answering node is only trusted when its genesis matches the fork
//     state — an unrelated node occupying the port must not clear the flag,
//   - when it can be determined, the spawned process must be the RPC listener:
//     the fork keeps the source chain's genesis hash, so a stale source or
//     fork node sharing the port would otherwise pass the genesis check and
//     supply a wrong fork boundary.
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
      const rpcPort = rpcPortOf(rpcUrl);
      const listening =
        ckbProcess.pid != null && rpcPort != null ? isProcessListeningOnPort(ckbProcess.pid, rpcPort) : null;
      if (listening === false) {
        // Something else is answering at the RPC URL while our process has not
        // bound the port (yet). Do not read the fork boundary from it.
        logger.debug(`Waiting for the spawned CKB process to bind the RPC port ${rpcPort} ..`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
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

async function failDaemonStartup(error: Error, pid: number, pidFile: string): Promise<never> {
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
    // The child may have exited while cleanup signals were sent. If liveness
    // cannot be checked, preserve the PID file for a later explicit stop.
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

async function startDaemon(waitForFiber = false) {
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
      const identityOk = await verifyDaemonIdentity(existing.pid, existing);
      if (identityOk) {
        if (existing.status === 'starting') {
          throw new Error(`Another CKB devnet daemon startup is already in progress (PID ${existing.pid}).`);
        }
        throw new Error(
          `A CKB devnet daemon is already running (PID ${existing.pid}). Stop it first with: offckb node stop`,
        );
      }
      logger.warn(
        `PID ${existing.pid} from ${pidFile} belongs to another process; removing stale daemon metadata without signaling it.`,
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
    status: 'starting',
  };
  try {
    writePidFile(pidFile, metadata);
  } catch (error) {
    closeFileDescriptors(out, err);
    return failDaemonStartup(error as Error, child.pid, pidFile);
  }

  // File descriptors are now owned by the spawned child; close our copies.
  closeFileDescriptors(out, err);

  const proxyUrl = `http://127.0.0.1:${settings.devnet.rpcProxyPort}`;
  try {
    const forkState = readForkState(settings.devnet.configPath);
    const timeoutMs = forkState ? FORK_NODE_READY_TIMEOUT_MS : NODE_READY_TIMEOUT_MS;
    // The proxy only starts after the child has a healthy CKB RPC and has
    // successfully spawned the miner, so this is the daemon's service-level
    // readiness check rather than a port/process check.
    const readiness = await waitForNodeReady(proxyUrl, timeoutMs, () => isProcessAlive(child.pid!));
    if (!readiness.ready) {
      throw new Error(
        `CKB devnet daemon failed to become ready. See ${logFile}. ${readiness.error ?? 'Daemon process exited.'}`,
      );
    }
    if (waitForFiber) {
      // node --fiber --daemon: the child records a running fiber environment
      // in runtime.json only after every Fiber startup check has passed.
      await waitForFiberRuntimeRunning(child.pid!, settings, logFile);
    }
    writePidFile(pidFile, { ...metadata, status: 'running' });
  } catch (error) {
    return failDaemonStartup(error as Error, child.pid, pidFile);
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

async function waitForFiberRuntimeRunning(managerPid: number, settings: Settings, logFile: string) {
  // Matches FIBER_DAEMON_READY_TIMEOUT_MS in fiber/daemon.ts: the child's
  // first run may still be downloading FNN.
  const timeoutMs = 10 * 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(managerPid)) {
      throw new Error(`The daemon exited before the fiber environment became ready. See ${logFile}.`);
    }
    const runtime = readRuntime(settings);
    if (runtime && runtime.managerPid === managerPid && runtime.status === 'running') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for the fiber environment to become ready. See ${logFile}.`);
}

export async function stopNode() {
  const { pidFile } = resolveDaemonPaths();

  const metadata = readPidFile(pidFile);
  if (!metadata) {
    logger.warn(`No daemon PID file found at ${pidFile}. Is the devnet daemon running?`);
    logger.result({ command: 'node.stop', stopped: false, reason: 'not-running' });
    return;
  }

  // FNNs managed by a separate fiber daemon must be stopped by that daemon's
  // owner command; node stop never reaches across another manager.
  const settings = readSettings();
  const fiberDaemon = readPidFile(fiberDaemonPaths(settings).pidFile);
  if (fiberDaemon && Number.isInteger(fiberDaemon.pid) && fiberDaemon.pid > 0 && isProcessAlive(fiberDaemon.pid)) {
    throw new Error(
      `Fiber nodes are managed by a separate fiber daemon (PID ${fiberDaemon.pid}). ` +
        'Stop them first with: offckb fiber stop',
    );
  }
  const fiberRuntime = readLiveRuntime(settings);
  if (fiberRuntime && fiberRuntime.managerPid !== metadata.pid) {
    logger.warn(
      `FNN nodes appear to be managed by a foreground OffCKB process (PID ${fiberRuntime.managerPid}); ` +
        'stop them in that terminal. Continuing to stop the CKB daemon...',
    );
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
