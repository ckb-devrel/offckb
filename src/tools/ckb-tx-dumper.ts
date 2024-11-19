import path from 'path';
import { execSync } from 'child_process';
import { packageRootPath } from '../cfg/setting';

export interface DumpOption {
  rpc: string;
  txJsonFilePath: string;
  outputFilePath: string;
}

export function dumpTransaction({ rpc, txJsonFilePath, outputFilePath }: DumpOption) {
  const ckbTransactionDumperPath = path.resolve(packageRootPath, 'node_modules/.bin/ckb-transaction-dumper');

  // todo: replace
  // const ckbCliPath = getCKBCliBinaryPath("")
  const command = `${ckbTransactionDumperPath} --rpc ${rpc} --tx "${txJsonFilePath}" --output "${outputFilePath}"`;

  try {
    execSync(command, { stdio: 'inherit' });
    console.debug('Dump transaction successfully');
  } catch (error: unknown) {
    console.error('Command failed:', (error as Error).message);
  }
}
