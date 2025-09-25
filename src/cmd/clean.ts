import fs from 'fs';
import { isFolderExists } from '../util/fs';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export function clean() {
  const settings = readSettings();
  const allDevnetDataPath = settings.devnet.configPath;
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
