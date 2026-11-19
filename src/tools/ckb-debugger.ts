import { spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readSettings } from '../cfg/setting';
import { nativeBinaryFileName } from '../plugins/manifest';
import { getNativeBinaryPath } from '../plugins/store';
import { ensureCommandShim } from '../plugins/shims';
import { installPlugin } from '../plugins/install';
import { getVersionFromBinary, isVersionAtLeast } from '../plugins/native';

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
   * Resolve the binary to execute, in order:
   *   1. the `ckb-debugger` on PATH (the shim written next to offckb), which
   *      also covers tools like ckb-testtool that spawn the bare name;
   *   2. the binary managed by the binary tool plugin registry (stable path);
   *   3. a leftover pre-plugin install under tools.rootFolder, until the
   *      tool is migrated with `offckb plugin install ckb-debugger`.
   *
   * Returns null when none of them is usable.
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
    const registered = getNativeBinaryPath('ckb-debugger');
    if (registered) return registered;
    try {
      const legacy = path.join(readSettings().tools.rootFolder, 'ckb-debugger', nativeBinaryFileName('ckb-debugger'));
      if (fs.existsSync(legacy)) return legacy;
    } catch {
      // Settings unreadable: treat the leftover location as absent.
    }
    return null;
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
   * Install (or migrate) the native ckb-debugger binary through the binary
   * tool plugin registry: one managed stable path, one PATH shim policy, and
   * the same install/upgrade flow as every other binary tool. An existing
   * pre-plugin install is adopted instead of re-downloaded.
   *
   * `offckb create` runs this check for every new project, so a managed
   * binary that already satisfies the pinned minimum short-circuits locally
   * without touching the network; `offckb plugin install ckb-debugger` stays
   * the explicit upgrade path.
   */
  static installCKBDebuggerBinary(
    reserved: ReadonlySet<string> = new Set(),
  ): Promise<{ binaryPath: string; version: string | null; alreadyInstalled: boolean } | unknown> {
    try {
      const existing = getNativeBinaryPath('ckb-debugger');
      if (existing) {
        const version = getVersionFromBinary(existing);
        if (version && isVersionAtLeast(version, readSettings().tools.ckbDebugger.minVersion)) {
          ensureCommandShim('ckb-debugger', existing);
          return Promise.resolve({ binaryPath: existing, version, alreadyInstalled: true });
        }
      }
    } catch {
      // Unreadable settings/registry: fall through to the full install path,
      // which reports actionable errors.
    }
    return installPlugin('ckb-debugger', reserved, {});
  }

  static runWithArgs(args: string[]): void {
    this.execute(args);
  }
}
