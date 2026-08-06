import { spawnSync, execSync } from 'child_process';
import { readSettings } from '../cfg/setting';
import { CKBDebuggerInstaller, isVersionAtLeast } from './ckb-debugger-install';

export interface DebugOption {
  fullTxJsonFilePath: string;
  cellIndex: number;
  cellType: 'output' | 'input';
  scriptGroupType: 'lock' | 'type';
}

export class CKBDebugger {
  private static execute(args: string[]): void {
    if (!this.isBinaryInstalled()) {
      throw new Error(
        'ckb-debugger is not installed. Install it once with: offckb install ckb-debugger',
      );
    }
    const command = `ckb-debugger ${args.join(' ')}`;
    execSync(command, { stdio: 'inherit' });
  }

  static runRaw(options: string) {
    const args = options.split(' ').filter((arg) => arg.trim());
    this.execute(args);
  }

  static async runTxCellScript({ fullTxJsonFilePath, cellIndex, cellType, scriptGroupType }: DebugOption) {
    const args = [
      '--tx-file',
      fullTxJsonFilePath,
      '--cell-index',
      cellIndex.toString(),
      '--cell-type',
      cellType,
      '--script-group-type',
      scriptGroupType,
    ];
    await this.execute(args);
  }

  static isBinaryInstalled() {
    const result = spawnSync('ckb-debugger', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  static isBinaryVersionValid() {
    const result = spawnSync('ckb-debugger', ['--version']);
    if (result.status !== 0) {
      return false;
    }
    try {
      const version = result.stdout.toString().split(' ')[1];
      const settings = readSettings();
      if (!isVersionAtLeast(version, settings.tools.ckbDebugger.minVersion)) {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Install the native ckb-debugger binary by downloading the prebuilt
   * release asset for the current platform (see CKBDebuggerInstaller).
   * Throws on failure; callers that can degrade should catch the error.
   */
  static async installCKBDebuggerBinary() {
    await CKBDebuggerInstaller.install();
  }

  // Additional convenience methods that work with the native binary CLI
  static async runWithArgs(args: string[]) {
    await this.execute(args);
  }

  static async version() {
    const result = spawnSync('ckb-debugger', ['--version'], { encoding: 'utf8' });
    return {
      exitCode: result.status || 0,
      output: result.stdout,
      error: result.stderr,
    };
  }
}
