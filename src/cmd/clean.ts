import fs from 'fs';
import path from 'path';
import { isFolderExists } from '../util/fs';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';
import { isProcessAlive, readPidFile } from '../util/daemon';
import { acquireEnvLock } from '../fiber/env-lock';
import { assertFiberFullyStopped } from '../fiber/clean';
import { fiberNodePaths, fiberRootPath } from '../fiber/paths';
import { removeRuntimeFileIfStale } from '../fiber/runtime';

export interface CleanOptions {
  data?: boolean;
}

function assertCkbDaemonStopped() {
  const pidFile = path.join(readSettings().devnet.dataPath, 'logs', 'daemon.pid');
  const metadata = readPidFile(pidFile);
  if (metadata && Number.isInteger(metadata.pid) && metadata.pid > 0 && isProcessAlive(metadata.pid)) {
    throw new Error(
      `The CKB devnet daemon is still running (PID ${metadata.pid}). Stop it first with: offckb node stop`,
    );
  }
}

function fiberStoreDirs(settings: ReturnType<typeof readSettings>): string[] {
  const nodesDir = path.join(fiberRootPath(settings), 'nodes');
  if (!isFolderExists(nodesDir)) return [];
  return fs
    .readdirSync(nodesDir)
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => fiberNodePaths(Number(entry), settings).fiberStoreDir)
    .filter((storeDir) => isFolderExists(storeDir));
}

export function clean(options?: CleanOptions) {
  const settings = readSettings();
  const allDevnetDataPath = settings.devnet.configPath;
  const dataOnly = options?.data || false;

  // The environment lock lives next to the devnet directory, so it can be
  // held while the whole devnet tree (including every fiber store) is
  // deleted; other OffCKB processes stay out for the whole operation.
  const lock = acquireEnvLock(dataOnly ? 'offckb clean --data' : 'offckb clean');
  try {
    assertCkbDaemonStopped();
    // Any fiber data being removed requires every FNN stopped; refusing when
    // that cannot be confirmed is cheaper than corrupting a live store.
    assertFiberFullyStopped(settings);

    if (dataOnly) {
      // Only clean the chain data subdirectory
      const chainDataPath = settings.devnet.dataPath;
      if (isFolderExists(chainDataPath)) {
        try {
          fs.rmSync(chainDataPath, { recursive: true });
          logger.info(`Chain data cleaned. Devnet config files preserved.`);
        } catch (error: unknown) {
          throw new Error(`Failed to clean chain data. Did you stop the chain first? ${(error as Error).message}`);
        }
      } else {
        logger.info(`Nothing to clean. Chain data directory ${chainDataPath} not found.`);
      }

      // Fiber stores (channels, payments, runtime records) can no longer map
      // onto the reset chain and are removed too; node configs, keys and
      // passwords are kept.
      removeRuntimeFileIfStale(settings);
      for (const storeDir of fiberStoreDirs(settings)) {
        fs.rmSync(storeDir, { recursive: true, force: true });
        logger.info(`Fiber store cleaned: ${storeDir}`);
      }
    } else {
      // Clean everything - the original behavior
      // this is the root folder of devnet, it contains config, data, debugFullTransactions, transactions, failed-transactions, contracts
      // and the whole fiber environment (configs, keys, stores, logs)
      if (isFolderExists(allDevnetDataPath)) {
        try {
          fs.rmSync(allDevnetDataPath, { recursive: true });
          logger.info(`Chain data cleaned.`);
        } catch (error: unknown) {
          throw new Error(`Failed to clean devnet data. Did you stop the chain first? ${(error as Error).message}`);
        }
      } else {
        logger.info(`Nothing to clean. Devnet data directory ${allDevnetDataPath} not found.`);
      }
    }
  } finally {
    lock.release();
  }
}
