import path from 'path';
import { execSync } from 'child_process';
import { packageRootPath } from '../cfg/setting';
import { logger } from '../util/logger';

export interface DumpOption {
  rpc: string;
  txJsonFilePath: string;
  outputFilePath: string;
}

export function dumpTransaction({ rpc, txJsonFilePath, outputFilePath }: DumpOption) {
  const ckbTransactionDumperPath = path.resolve(packageRootPath, 'node_modules/.bin/ckb-transaction-dumper');

  const command = `${ckbTransactionDumperPath} --rpc ${rpc} --tx "${txJsonFilePath}" --output "${outputFilePath}"`;

  try {
    execSync(command, { stdio: 'inherit' });
    logger.debug('Dump transaction successfully');
  } catch (error: unknown) {
    logger.error('Command failed:', (error as Error).message);
  }
}
