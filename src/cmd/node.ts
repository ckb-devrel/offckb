import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { initChainIfNeeded } from '../node/init-chain';
import { installCKBBinary } from '../node/install';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { encodeBinPathForTerminal } from '../util/encoding';
import { createRPCProxy } from '../tools/rpc-proxy';
import { Network } from '../type/base';
import { logger } from '../util/logger';

export interface NodeProp {
  version?: string;
  network?: Network;
  binaryPath?: string;
  daemon?: boolean;
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
    ckbBinPath = encodeBinPathForTerminal(binaryPath);
    logger.info(`Using custom CKB binary path: ${ckbBinPath}`);
  } else {
    await installCKBBinary(ckbVersion);
    ckbBinPath = encodeBinPathForTerminal(getCKBBinaryPath(ckbVersion));
  }
  await initChainIfNeeded();
  const devnetConfigPath = encodeBinPathForTerminal(settings.devnet.configPath);

  const ckbCmd = `${ckbBinPath} run -C ${devnetConfigPath}`;
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

function startDaemon() {
  const settings = readSettings();
  const daemonLogDir = path.join(settings.devnet.dataPath, 'logs');
  fs.mkdirSync(daemonLogDir, { recursive: true });

  const logFile = path.join(daemonLogDir, 'daemon.log');
  const pidFile = path.join(daemonLogDir, 'daemon.pid');

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  // Re-launch the current CLI without the --daemon flag so the child process
  // runs the normal foreground node logic in a detached background process.
  const scriptPath = process.argv[1] || require.main?.filename;
  if (!scriptPath) {
    logger.error('Unable to determine the CLI entry point for daemon mode.');
    return;
  }
  const childArgs = process.argv.slice(2).filter((arg) => arg !== '--daemon');
  const childEnv = { ...process.env, OFFCKB_DAEMON_CHILD: '1' };

  const child = spawn(process.execPath, [scriptPath, ...childArgs], {
    detached: true,
    stdio: ['ignore', out, err],
    env: childEnv,
  });

  child.unref();

  fs.writeFileSync(pidFile, String(child.pid));

  logger.success(`CKB devnet daemon started with PID ${child.pid}.`);
  logger.info(`Logs: ${logFile}`);
  logger.info(`PID file: ${pidFile}`);
  logger.info('Stop the daemon with: offckb node stop');
}

export async function stopNode() {
  const settings = readSettings();
  const pidFile = path.join(settings.devnet.dataPath, 'logs', 'daemon.pid');

  if (!fs.existsSync(pidFile)) {
    logger.warn(`No daemon PID file found at ${pidFile}. Is the devnet daemon running?`);
    return;
  }

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.error(`Invalid PID in ${pidFile}: ${pid}`);
    return;
  }

  if (!isProcessAlive(pid)) {
    logger.warn(`Daemon process ${pid} is not running.`);
    cleanupPidFile(pidFile);
    return;
  }

  logger.info(`Stopping CKB devnet daemon (PID ${pid})...`);
  const signalTarget = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(signalTarget, 'SIGTERM');
  } catch (error) {
    logger.error(`Failed to send SIGTERM to daemon process ${pid}:`, error);
    return;
  }

  const exited = await waitForProcessExit(pid, 5000);
  if (!exited) {
    logger.warn(`Daemon process ${pid} did not exit gracefully, sending SIGKILL...`);
    try {
      process.kill(signalTarget, 'SIGKILL');
    } catch (error) {
      logger.error(`Failed to send SIGKILL to daemon process ${pid}:`, error);
    }
  }

  cleanupPidFile(pidFile);
  logger.success('CKB devnet daemon stopped.');
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
