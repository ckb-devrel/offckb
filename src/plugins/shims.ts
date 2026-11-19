import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';

/**
 * PATH shims for native tool plugins, generalizing the ckb-debugger shim
 * policy:
 *
 *  - A shim is written next to the offckb binary, so any directory already on
 *    PATH for offckb resolves `<command>` for generated projects and other
 *    tools, without touching the user's PATH configuration.
 *  - Every host-written file carries an `.offckb` sidecar marker and (for
 *    scripts) an embedded marker comment. A file without either is foreign —
 *    e.g. a user's own cargo-installed binary — and is never clobbered.
 *  - On Windows a bare `.cmd` is invisible to spawnSync without a shell
 *    (Node >= 20.12.2, CVE-2024-27980), so a real `<command>.exe` is also
 *    placed: a hard link to the managed binary, or a copy when linking fails
 *    (e.g. across drives).
 *  - Shim failures never fail an install: the managed binary and the
 *    `offckb <command>` / `offckb plugin which` paths keep working.
 */

/** Marker sidecar written next to every offckb-owned shim file. */
export function shimMarkerPath(targetPath: string): string {
  return `${targetPath}.offckb`;
}

function embeddedMarker(command: string): string {
  return process.platform === 'win32' ? `@rem offckb-managed ${command} shim` : `# offckb-managed ${command} shim`;
}

function isOwned(targetPath: string, command: string): boolean {
  if (fs.existsSync(shimMarkerPath(targetPath))) return true;
  try {
    const existing = fs.readFileSync(targetPath, 'utf8');
    return existing.includes(embeddedMarker(command));
  } catch {
    return false;
  }
}

/** Directory that holds the offckb binary on PATH, or null when not found. */
export function shimDirectory(): string | null {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(isWindows ? 'where' : 'which', ['offckb'], { encoding: 'utf8' });
  // `which`/`where` failing to spawn leaves stdout null; treat that as
  // "no offckb on PATH" rather than crashing.
  const stdout = result.stdout ?? '';
  const offckbPath = stdout.trim().split('\n')[0];
  return offckbPath ? path.dirname(offckbPath) : null;
}

function publishFile(write: (stagingPath: string) => void, targetPath: string): void {
  const stagingPath = `${targetPath}.staging-${process.pid}`;
  try {
    write(stagingPath);
    fs.renameSync(stagingPath, targetPath);
  } finally {
    fs.rmSync(stagingPath, { force: true });
  }
}

function claimOwnership(targetPath: string): void {
  fs.writeFileSync(shimMarkerPath(targetPath), 'offckb-managed\n', { mode: 0o600 });
}

/**
 * Publish a shim for `command` pointing at the managed binary. Returns the
 * primary shim path, or null when skipped (foreign file in the way, or offckb
 * itself is not on PATH).
 */
export function ensureCommandShim(command: string, binaryPath: string): string | null {
  const directory = shimDirectory();
  if (!directory) {
    logger.warn(
      'Could not find the offckb binary in PATH, so no shim was created. ' +
        `Tools that call \`${command}\` directly will need it added to PATH manually.`,
    );
    return null;
  }
  const isWindows = process.platform === 'win32';
  const marker = embeddedMarker(command);
  let primary: string | null = null;

  const targets: Array<{ path: string; write: (stagingPath: string) => void }> = isWindows
    ? [
        {
          path: path.join(directory, `${command}.cmd`),
          write: (staging) => {
            fs.writeFileSync(staging, `${marker}\r\n@echo off\r\n"${binaryPath}" %*\r\n`);
          },
        },
        {
          // Real .exe on PATH for tools that spawn without a shell. A hard
          // link tracks the managed binary; copying covers cross-drive links.
          path: path.join(directory, `${command}.exe`),
          write: (staging) => {
            try {
              fs.linkSync(binaryPath, staging);
            } catch {
              fs.copyFileSync(binaryPath, staging);
            }
          },
        },
      ]
    : [
        {
          path: path.join(directory, command),
          write: (staging) => {
            fs.writeFileSync(staging, `#!/bin/sh\n${marker}\nexec "${binaryPath}" "$@"\n`);
            fs.chmodSync(staging, 0o755);
          },
        },
      ];

  for (const target of targets) {
    try {
      if (fs.existsSync(target.path) && !isOwned(target.path, command)) {
        logger.warn(
          `A file already exists at ${target.path} that was not created by offckb; leaving it untouched. ` +
            `Tools that call \`${command}\` directly will need it added to PATH manually.`,
        );
        continue;
      }
      publishFile(target.write, target.path);
      try {
        claimOwnership(target.path);
      } catch (error) {
        logger.warn(`Could not write the ownership marker for ${target.path}: ${(error as Error).message}.`);
      }
      primary ??= target.path;
    } catch (error) {
      logger.warn(`Could not write the ${command} shim at ${target.path}: ${(error as Error).message}.`);
    }
  }
  if (primary) logger.info(`✅ ${command} shim updated: ${primary}`);
  return primary;
}

/** Remove offckb-owned shims only; foreign files are left in place. */
export function removeCommandShims(command: string): void {
  const directory = shimDirectory();
  if (!directory) return;
  const isWindows = process.platform === 'win32';
  const candidates = isWindows
    ? [path.join(directory, `${command}.cmd`), path.join(directory, `${command}.exe`)]
    : [path.join(directory, command)];
  for (const target of candidates) {
    try {
      if (fs.existsSync(shimMarkerPath(target))) {
        fs.rmSync(shimMarkerPath(target), { force: true });
        fs.rmSync(target, { force: true });
      } else if (fs.existsSync(target) && isOwned(target, command)) {
        // Embedded marker only (e.g. written before sidecar markers existed).
        fs.rmSync(target, { force: true });
      }
    } catch (error) {
      logger.warn(`Could not remove the ${command} shim at ${target}: ${(error as Error).message}.`);
    }
  }
}
