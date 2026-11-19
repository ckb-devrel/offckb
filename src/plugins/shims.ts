import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../cfg/setting';
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

interface ShimMarker {
  v: 1;
  command: string;
  /** SHA-256 of the shim file content at the time offckb wrote it. */
  sha256: string;
  /**
   * Canonical plugin home that owns this shim. Global PATH shims are shared
   * across OFFCKB_PLUGIN_HOME values; only the owning home may update or
   * remove its shim, so isolated homes never clobber each other.
   */
  home: string;
}

/** The plugin home that would own shims written by this process. */
function ownerHome(): string {
  const configured = process.env.OFFCKB_PLUGIN_HOME || path.join(dataPath, 'plugins');
  try {
    return fs.realpathSync(configured);
  } catch {
    return path.resolve(configured);
  }
}

function sha256OfFile(targetPath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  } catch {
    return null;
  }
}

function readMarker(targetPath: string): ShimMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(shimMarkerPath(targetPath), 'utf8')) as ShimMarker;
    return value?.v === 1 &&
      typeof value.command === 'string' &&
      typeof value.sha256 === 'string' &&
      typeof value.home === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

function embeddedMarker(command: string): string {
  return process.platform === 'win32' ? `@rem offckb-managed ${command} shim` : `# offckb-managed ${command} shim`;
}

/**
 * Ownership is claimed only when the file is exactly what offckb wrote: the
 * sidecar marker records the content hash, so a stale marker left next to a
 * file the user replaced never authorizes an overwrite or a delete. Files
 * replaced by symlinks are never owned. Scripts written before sidecar
 * markers existed are still recognized by their embedded marker comment.
 */
function isOwned(targetPath: string, command: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  const digest = sha256OfFile(targetPath);
  if (!digest) return false;
  const marker = readMarker(targetPath);
  if (marker) {
    return marker.command === command && marker.sha256 === digest && marker.home === ownerHome();
  }
  // Legacy shims written by the pre-sidecar installer only carry an embedded
  // marker comment, and they exist on real user machines. Only the default
  // plugin home (production installs, no OFFCKB_PLUGIN_HOME) claims them;
  // isolated homes require a sidecar marker, closing cross-home ownership.
  if (process.env.OFFCKB_PLUGIN_HOME) return false;
  try {
    return fs.readFileSync(targetPath, 'utf8').includes(embeddedMarker(command));
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
  const stdout = result?.stdout ?? '';
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

function claimOwnership(targetPath: string, command: string): void {
  const digest = sha256OfFile(targetPath);
  if (!digest) throw new Error(`Could not hash the shim at ${targetPath}`);
  const marker: ShimMarker = { v: 1, command, sha256: digest, home: ownerHome() };
  fs.writeFileSync(shimMarkerPath(targetPath), JSON.stringify(marker) + '\n', { mode: 0o600 });
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
        claimOwnership(target.path, command);
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

/** Remove offckb-owned shims only; foreign files (and stale markers beside them) are left in place. */
export function removeCommandShims(command: string): void {
  const directory = shimDirectory();
  if (!directory) return;
  const isWindows = process.platform === 'win32';
  const candidates = isWindows
    ? [path.join(directory, `${command}.cmd`), path.join(directory, `${command}.exe`)]
    : [path.join(directory, command)];
  for (const target of candidates) {
    try {
      // Ownership re-verifies the recorded content hash, so a stale marker
      // next to a file the user replaced never authorizes deletion.
      if (!isOwned(target, command)) continue;
      fs.rmSync(shimMarkerPath(target), { force: true });
      fs.rmSync(target, { force: true });
    } catch (error) {
      logger.warn(`Could not remove the ${command} shim at ${target}: ${(error as Error).message}.`);
    }
  }
}
