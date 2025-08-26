import { exec } from 'child_process';
import { initChainIfNeeded } from '../node/init-chain';
import { installCKBBinary } from '../node/install';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { encodeBinPathForTerminal } from '../util/encoding';
import { createRPCProxy } from '../tools/rpc-proxy';
import { Network } from '../type/base';
import { logger } from '../util/logger';

export interface NodeProp {
  version?: string;
}

export async function node({ version }: NodeProp) {
  const settings = readSettings();
  const ckbVersion = version || settings.bins.defaultCKBVersion;
  await installCKBBinary(ckbVersion);
  await initChainIfNeeded();

  const ckbBinPath = encodeBinPathForTerminal(getCKBBinaryPath(ckbVersion));
  const devnetConfigPath = encodeBinPathForTerminal(settings.devnet.configPath);

  const ckbCmd = `${ckbBinPath} run -C ${devnetConfigPath}`;
  const minerCmd = `${ckbBinPath} miner -C ${devnetConfigPath}`;
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
