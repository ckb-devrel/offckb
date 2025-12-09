import fs from 'fs';
import { isFolderExists } from '../util/fs';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export interface CleanOptions {
  data?: boolean;
}

export function clean(options?: CleanOptions) {
  const settings = readSettings();
  const allDevnetDataPath = settings.devnet.configPath;
  const dataOnly = options?.data || false;

  if (dataOnly) {
    // Only clean the chain data subdirectory
    const chainDataPath = settings.devnet.dataPath;
    if (isFolderExists(chainDataPath)) {
      try {
        fs.rmSync(chainDataPath, { recursive: true });
        logger.info(`Chain data cleaned. Devnet config files preserved.`);
      } catch (error: unknown) {
        logger.info(`Did you stop running the chain first?`);
        logger.error((error as Error).message);
      }
    } else {
      logger.info(`Nothing to clean. Chain data directory ${chainDataPath} not found.`);
    }
  } else {
    // Clean everything - the original behavior
    // this is the root folder of devnet, it contains config, data, debugFullTransactions, transactions, failed-transactions, contracts
    if (isFolderExists(allDevnetDataPath)) {
      try {
        fs.rmSync(allDevnetDataPath, { recursive: true });
        logger.info(`Chain data cleaned.`);
      } catch (error: unknown) {
        logger.info(`Did you stop running the chain first?`);
        logger.error((error as Error).message);
      }
    } else {
      logger.info(`Nothing to clean. Devnet data directory ${allDevnetDataPath} not found.`);
    }
  }
}
