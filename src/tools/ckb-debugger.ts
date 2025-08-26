import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import { readSettings } from '../cfg/setting';
import { CkbDebuggerWasi } from './ckb-debugger-wasm';

export interface DebugOption {
  fullTxJsonFilePath: string;
  cellIndex: number;
  cellType: 'output' | 'input';
  scriptGroupType: 'lock' | 'type';
}

export class CKBDebugger {
  private static wasmDebugger: CkbDebuggerWasi | null = null;
  private static useWasm: boolean | null = null;

  private static getWasmDebugger(): CkbDebuggerWasi {
    if (!this.wasmDebugger) {
      const wasmPath = path.join(__dirname, 'ckb-debugger.wasm');
      this.wasmDebugger = new CkbDebuggerWasi({
        wasmPath,
        captureOutput: false, // Use stdio for consistency with CLI version
      });
    }
    return this.wasmDebugger;
  }

  private static shouldUseWasm(): boolean {
    if (this.useWasm !== null) {
      return this.useWasm;
    }

    // Check if CLI version is available and valid
    if (this.isBinaryInstalled() && this.isBinaryVersionValid()) {
      console.log('Using native ckb-debugger (better performance)');
      this.useWasm = false;
    } else {
      console.log('Native ckb-debugger not available, falling back to WASM version');
      this.useWasm = true;
    }

    return this.useWasm;
  }

  private static async execute(args: string[]): Promise<void> {
    if (this.shouldUseWasm()) {
      const result = await this.getWasmDebugger().run(args);
      if (result.exitCode !== 0) {
        process.exit(result.exitCode);
      }
    } else {
      const command = `ckb-debugger ${args.join(' ')}`;
      execSync(command, { stdio: 'inherit' });
    }
  }

  static async runRaw(options: string) {
    const args = options.split(' ').filter((arg) => arg.trim());
    await this.execute(args);
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
      if (version < settings.tools.ckbDebugger.minVersion) {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  static installCKBDebugger() {
    const command = `cargo install --git https://github.com/nervosnetwork/ckb-standalone-debugger ckb-debugger`;
    try {
      console.log('Installing ckb-debugger...');
      execSync(command, { stdio: 'inherit' });
      console.log('ckb-debugger installed successfully. You can uninstall it by running: cargo uninstall ckb-debugger');
      // Reset the use wasm flag so it re-evaluates next time
      this.useWasm = null;
    } catch (error) {
      console.error('Failed to install ckb-debugger:', error);
      process.exit(1);
    }
  }

  // Additional convenience methods that work with both CLI and WASM
  static async runWithArgs(args: string[]) {
    await this.execute(args);
  }

  static async version() {
    if (this.shouldUseWasm()) {
      const result = await this.getWasmDebugger().run(['--version']);
      return result;
    } else {
      const result = spawnSync('ckb-debugger', ['--version'], { encoding: 'utf8' });
      return {
        exitCode: result.status || 0,
        output: result.stdout,
        error: result.stderr,
      };
    }
  }
}
