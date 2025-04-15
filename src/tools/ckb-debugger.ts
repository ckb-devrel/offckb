import { spawnSync, execSync } from 'child_process';
import { readSettings } from '../cfg/setting';

export interface DebugOption {
  fullTxJsonFilePath: string;
  cellIndex: number;
  cellType: 'output' | 'input';
  scriptGroupType: 'lock' | 'type';
}

export class CKBDebugger {
  static runRaw(options: string) {
    const command = `ckb-debugger ${options}`;
    execSync(command, { stdio: 'inherit' });
  }

  static runTxCellScript({ fullTxJsonFilePath, cellIndex, cellType, scriptGroupType }: DebugOption) {
    const command = `ckb-debugger --tx-file ${fullTxJsonFilePath} --cell-index ${cellIndex} --cell-type ${cellType} --script-group-type ${scriptGroupType}`;
    execSync(command, { stdio: 'inherit' });
  }

  static isBinaryInstalled() {
    const result = spawnSync('ckb-debugger', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  static isBinaryVersionValid() {
    const result = spawnSync('ckb-debugger', ['--version']);
    if (result.status !== 0) {
      console.error('ckb-debugger is not installed');
      return false;
    }
    const version = result.stdout.toString().split(' ')[1];
    const settings = readSettings();
    if (version < settings.tools.ckbDebugger.minVersion) {
      console.error(`ckb-debugger version ${version} is less than ${settings.tools.ckbDebugger.minVersion}`);
      return false;
    }
    return true;
  }

  static installCKBDebugger() {
    const command = `cargo install --git https://github.com/nervosnetwork/ckb-standalone-debugger ckb-debugger`;
    try {
      console.log('Installing ckb-debugger...');
      execSync(command);
      console.log('ckb-debugger installed successfully.');
    } catch (error) {
      console.error('Failed to install ckb-debugger:', error);
      process.exit(1);
    }
  }
}
