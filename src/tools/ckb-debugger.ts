import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import { readSettings } from '../cfg/setting';
import { CkbDebuggerWasi } from './ckb-debugger-wasm';
import { logger } from '../util/logger';

export interface DebugOption {
  fullTxJsonFilePath: string;
  cellIndex: number;
  cellType: 'output' | 'input';
  scriptGroupType: 'lock' | 'type';
}

export class CKBDebugger {
  private static wasmDebugger: CkbDebuggerWasi | null = null;

  private static getWasmDebugger(): CkbDebuggerWasi {
    if (!this.wasmDebugger) {
      const wasmPath = path.join(__dirname, 'ckb-debugger.wasm');
      this.wasmDebugger = new CkbDebuggerWasi({
        wasmPath,
        captureOutput: false, // Use stdio directly since custom capture doesn't work with WASI
      });
    }
    return this.wasmDebugger;
  }

  /**
   * Check if we're in a recursive call to avoid infinite loops
   * This happens when ckb-debugger binary points to offckb CLI
   */
  private static isRecursiveCall(): boolean {
    // Check if we're already running as a ckb-debugger process
    if (process.argv[1] && process.argv[1].includes('ckb-debugger')) {
      logger.debug('Detected ckb-debugger process, using WASM to avoid recursion');
      return true;
    }

    // Check if we're running the debugger command (which could be called from ckb-debugger binary)
    if (process.argv.includes('debugger')) {
      logger.debug('Detected debugger command, using WASM to avoid recursion');
      return true;
    }

    return false;
  }

  private static shouldUseWasm(): boolean {
    if (this.isRecursiveCall()) {
      return true;
    }

    if (this.isBinaryInstalled() && this.isBinaryVersionValid()) {
      logger.debug('Using native ckb-debugger (better performance)');
      return false;
    } else {
      logger.debug('Native ckb-debugger not available, falling back to WASM version');
      return true;
    }
  }

  private static async execute(args: string[]): Promise<void> {
    if (this.shouldUseWasm()) {
      try {
        const result = await this.getWasmDebugger().run(args);
        if (result.exitCode !== 0) {
          process.exit(result.exitCode);
        }
      } catch (error) {
        logger.error('WASM debugger execution failed:', error as Error);
        process.exit(1);
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

  static installCKBDebuggerBinary() {
    const command = `cargo install --git https://github.com/nervosnetwork/ckb-standalone-debugger ckb-debugger`;
    try {
      logger.info('Installing ckb-debugger...');
      execSync(command, { stdio: 'inherit' });
      logger.info('ckb-debugger installed successfully. You can uninstall it by running: cargo uninstall ckb-debugger');
    } catch (error) {
      logger.error('Failed to install ckb-debugger:', error as Error);
      process.exit(1);
    }
  }

  /**
   * Create a ckb-debugger fallback binary that points to offckb debugger
   * This creates a shell script that calls: offckb debugger [args]
   * Purpose: Reduce user friction by providing a placeholder when native binary is not available
   * Users can install the real ckb-debugger binary for better performance if needed
   *
   * On Windows, we create a Node.js script instead of a batch file because batch files
   * do not properly forward stdin to child processes. This is critical for tools like
   * ckb-testtool that pass transaction data via stdin (e.g., `--tx-file -`).
   */
  static createCkbDebuggerFallback() {
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const isWindows = process.platform === 'win32';

    // Find the offckb binary location
    let offckbPath: string;
    if (isWindows) {
      const result = spawnSync('where', ['offckb'], { encoding: 'utf8' });
      offckbPath = result.stdout.trim().split('\n')[0];
    } else {
      const result = spawnSync('which', ['offckb'], { encoding: 'utf8' });
      offckbPath = result.stdout.trim();
    }

    if (!offckbPath) {
      logger.error('❌ Could not find offckb binary. Please ensure offckb is installed and in your PATH.');
      process.exit(1);
    }

    // Get the directory where offckb is located
    const offckbDir = path.dirname(offckbPath);

    try {
      // Ensure directory exists
      fs.mkdirSync(offckbDir, { recursive: true });

      if (isWindows) {
        // On Windows, create a Node.js script that properly forwards stdin
        // Batch files (.cmd) do NOT forward stdin to child processes, which breaks
        // tools like ckb-testtool that use `spawnSync('ckb-debugger', args, { input: data })`
        const jsPath = path.join(offckbDir, 'ckb-debugger.js');
        const cmdPath = path.join(offckbDir, 'ckb-debugger.cmd');

        // Node.js script that uses spawn with stdio: 'inherit' to forward stdin properly
        const jsContent = `#!/usr/bin/env node
const { spawn } = require('child_process');
const child = spawn('offckb', ['debugger', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false
});
child.on('error', (err) => {
  console.error('Failed to start offckb:', err.message);
  process.exit(1);
});
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
`;

        // CMD wrapper that calls the Node.js script
        // %~dp0 expands to the directory containing the batch file
        const cmdContent = `@echo off
node "%~dp0ckb-debugger.js" %*
`;

        fs.writeFileSync(jsPath, jsContent);
        fs.writeFileSync(cmdPath, cmdContent);

        logger.info(`✅ Created ckb-debugger fallback at: ${cmdPath}`);
        logger.info(`   Helper script: ${jsPath}`);
      } else {
        // Unix shell script - use exec to replace the shell process
        // This ensures stdin is properly inherited by offckb
        const targetPath = path.join(offckbDir, 'ckb-debugger');
        const binContent = `#!/bin/sh
exec offckb debugger "$@"`;

        fs.writeFileSync(targetPath, binContent);
        fs.chmodSync(targetPath, '755');

        logger.info(`✅ Created ckb-debugger fallback at: ${targetPath}`);
      }

      logger.info(`   This fallback uses WASM and calls: offckb debugger [args]`);
      logger.info(
        `   For better performance, install the real binary: cargo install --git https://github.com/nervosnetwork/ckb-standalone-debugger ckb-debugger`,
      );
    } catch (error: unknown) {
      logger.error(`❌ Failed to create ckb-debugger fallback: ${(error as Error).message}`);
      logger.error(`   Make sure you have write permissions to: ${offckbDir}`);
      process.exit(1);
    }
  }

  // Additional convenience methods that work with both native binary CLI and WASM
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
