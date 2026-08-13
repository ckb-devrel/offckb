import { spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import { CKBDebuggerInstaller, CkbDebuggerInstallResult } from './ckb-debugger-install';

export interface DebugOption {
  fullTxJsonFilePath: string;
  cellIndex: number;
  cellType: 'output' | 'input';
  scriptGroupType: 'lock' | 'type';
}

/**
 * Env var offckb sets on every `ckb-debugger` child it spawns. A stale
 * v0.4.x fallback shim (which runs `exec offckb debugger "$@"`) re-enters
 * offckb with this var set; resolveBinaryPath then stops instead of spawning
 * `ckb-debugger` on PATH again, which would recurse forever.
 */
const RECURSION_GUARD_ENV = 'OFFCKB_DEBUGGER_GUARD';

export class CKBDebugger {
  /**
   * Resolve the binary to execute: the `ckb-debugger` on PATH (the shim
   * written next to offckb) first, then the binary offckb manages under
   * tools.rootFolder. Returns null when neither is usable.
   *
   * The managed-path fallback covers two cases where the PATH probe fails:
   *  - Windows: a `.cmd` shim cannot be spawned without a shell since Node
   *    20.12.2 (CVE-2024-27980), so PATH probing alone always fails there;
   *  - offckb is not on PATH, so no shim was written, yet the managed binary
   *    is installed and usable.
   */
  private static resolveBinaryPath(): string | null {
    // When we are ourselves the child of a stale shim, the guard env var is
    // set: skip the PATH probe (it would hit the shim again) and go straight
    // to the managed binary.
    if (!process.env[RECURSION_GUARD_ENV]) {
      const probe = spawnSync('ckb-debugger', ['--version'], {
        stdio: 'ignore',
        env: { ...process.env, [RECURSION_GUARD_ENV]: '1' },
      });
      if (probe.status === 0) {
        return 'ckb-debugger';
      }
    }
    const installed = CKBDebuggerInstaller.getInstalledBinaryPath();
    return fs.existsSync(installed) ? installed : null;
  }

  private static execute(args: string[]): void {
    const binary = this.resolveBinaryPath();
    if (!binary) {
      throw new Error('ckb-debugger is not installed. Install it once with: offckb install ckb-debugger');
    }
    // Array argv form: argument splitting and shell injection are impossible.
    execFileSync(binary, args, {
      stdio: 'inherit',
      env: { ...process.env, [RECURSION_GUARD_ENV]: '1' },
    });
  }

  static runRaw(options: string): void {
    // `options` is a space-separated command line whose space-containing
    // paths are wrapped in quotes by callers (encodeBinPathForTerminal),
    // which also backslash-escapes embedded double quotes. execFileSync's
    // array argv does not run through a shell, so a naive split(' ') would
    // leave the literal quotes in the argument and break such paths. Split
    // quote-aware instead: a quoted segment stays one argv element, the
    // surrounding quotes are stripped, and escaped quotes (\") are unescaped.
    const args =
      options.match(/"(?:[^"\\]|\\.)*"|\S+/g)?.map((arg) => {
        if (arg.startsWith('"') && arg.endsWith('"')) {
          return arg.slice(1, -1).replace(/\\"/g, '"');
        }
        return arg;
      }) ?? [];
    this.execute(args);
  }

  static runTxCellScript({ fullTxJsonFilePath, cellIndex, cellType, scriptGroupType }: DebugOption): void {
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
    this.execute(args);
  }

  /**
   * Install the native ckb-debugger binary by downloading the prebuilt
   * release asset for the current platform (see CKBDebuggerInstaller).
   * Throws on failure; callers that can degrade should catch the error.
   */
  static installCKBDebuggerBinary(): Promise<CkbDebuggerInstallResult> {
    return CKBDebuggerInstaller.install();
  }

  static runWithArgs(args: string[]): void {
    this.execute(args);
  }
}
