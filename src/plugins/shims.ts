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
 *  - Only the default plugin home writes shims next to the offckb binary.
 *    An isolated home (OFFCKB_PLUGIN_HOME set, e.g. tests or throwaway
 *    environments) publishes under `<home>/bin` instead, so a temporary home
 *    can never plant shims on the user's real PATH that dangle once the
 *    home is cleaned up.
 *  - A shim whose owning home no longer exists is an orphan: no process can
 *    ever reclaim it through its owner, so any live home may adopt it for
 *    update or removal.
 *  - The shim script checks its target before exec: a managed binary that
 *    disappeared yields an actionable error and exit 127, not a bare shell
 *    "no such file".
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
   * Canonical plugin home that owns this shim. Only the default home
   * publishes to the global PATH; isolated homes publish under their own
   * `<home>/bin`, so a foreign marker on the global PATH normally means a
   * pre-gate install. A marker whose home directory no longer exists marks
   * an orphan that any live home may reclaim.
   */
  home: string;
}

/** True when OFFCKB_PLUGIN_HOME points this process at a non-default home. */
function isIsolatedHome(): boolean {
  const configured = process.env.OFFCKB_PLUGIN_HOME;
  if (!configured) return false;
  // Explicitly pointing OFFCKB_PLUGIN_HOME at the default home is not isolation.
  return canonicalHome(configured) !== canonicalHome(path.join(dataPath, 'plugins'));
}

/**
 * True only when the path provably does not exist. Permission or I/O errors
 * (EACCES, EIO, ...) fail closed: a home that cannot be stat'ed is treated
 * as alive so its shims are never reclaimed by mistake.
 */
function homeIsGone(home: string): boolean {
  try {
    fs.statSync(home);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * Canonicalize a home path the same way for every comparison: realpath when
 * it exists, resolved absolute path otherwise.
 */
function canonicalHome(configured: string): string {
  try {
    return fs.realpathSync(configured);
  } catch {
    return path.resolve(configured);
  }
}

/** The plugin home that would own shims written by this process. */
function ownerHome(): string {
  return canonicalHome(process.env.OFFCKB_PLUGIN_HOME || path.join(dataPath, 'plugins'));
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
    if (marker.command !== command || marker.sha256 !== digest) return false;
    if (marker.home === ownerHome()) return true;
    // Orphaned shim: the owning plugin home provably no longer exists (a
    // cleaned-up OFFCKB_PLUGIN_HOME or a deleted data directory), so no
    // process can ever reclaim the shim through its owner. Any live home may
    // adopt it for update or removal; a shim whose home still exists — or
    // cannot be stat'ed — stays foreign.
    return homeIsGone(marker.home);
  }
  // Legacy shims written by the pre-sidecar installer only carry an embedded
  // marker comment, and they exist on real user machines. Only the default
  // plugin home (production installs, no isolated OFFCKB_PLUGIN_HOME) claims
  // them; isolated homes require a sidecar marker, closing cross-home
  // ownership.
  if (isIsolatedHome()) return false;
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

/**
 * Directory this process may publish shims into (and remove them from).
 * Only the default home writes next to the offckb binary on the real PATH;
 * an isolated home publishes under `<home>/bin` and never consults — let
 * alone mutates — the global bin directory.
 */
function publishDirectory(): string | null {
  if (isIsolatedHome()) return path.join(ownerHome(), 'bin');
  return shimDirectory();
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
  // Never write through a symlinked marker: refuse foreign marker entries,
  // and publish atomically via an exclusively-created temporary file.
  if (fs.existsSync(shimMarkerPath(targetPath)) && fs.lstatSync(shimMarkerPath(targetPath)).isSymbolicLink()) {
    throw new Error(`Ownership marker must not be a symlink: ${shimMarkerPath(targetPath)}`);
  }
  const temporary = `${shimMarkerPath(targetPath)}.staging-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(marker) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, shimMarkerPath(targetPath));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Publish a shim for `command` pointing at the managed binary. Returns the
 * primary shim path, or null when skipped (foreign file in the way, or offckb
 * itself is not on PATH). `installHint` is the reinstall spec used in the
 * missing-binary repair message. Only pass a stable, safe spec (a catalog
 * command): relative descriptor paths depend on the caller's working
 * directory, pinned versions go stale, and user-supplied strings do not
 * belong in generated shell source. Without a hint the message stays generic.
 */
export function ensureCommandShim(command: string, binaryPath: string, installHint?: string): string | null {
  const isolated = isIsolatedHome();
  const directory = publishDirectory();
  if (!directory) {
    logger.warn(
      'Could not find the offckb binary in PATH, so no shim was created. ' +
        `Tools that call \`${command}\` directly will need it added to PATH manually.`,
    );
    return null;
  }
  if (isolated) {
    // The isolated home's bin directory is created on demand; it is not on
    // PATH, so the shim only serves callers that know the home.
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      logger.warn(`Could not create the shim directory ${directory}: ${(error as Error).message}.`);
      return null;
    }
  }
  const isWindows = process.platform === 'win32';
  const marker = embeddedMarker(command);
  // A managed binary that disappears (deleted home, manual cleanup) must
  // produce an actionable error, not a bare shell "no such file".
  const missing = `${command}: the offckb-managed binary is missing at ${binaryPath}.`;
  const repair = installHint
    ? `Reinstall it with: offckb plugin install ${installHint}, or delete this shim.`
    : `Reinstall the tool from its original source, or delete this shim.`;
  let primary: string | null = null;

  const targets: Array<{ path: string; write: (stagingPath: string) => void }> = isWindows
    ? [
        {
          path: path.join(directory, `${command}.cmd`),
          write: (staging) => {
            // goto form, not a parenthesized block: a `)` inside the binary
            // path (e.g. "Program Files (x86)") would terminate a block
            // early even inside quotes.
            fs.writeFileSync(
              staging,
              `${marker}\r\n@echo off\r\n` +
                `if exist "${binaryPath}" goto run\r\n` +
                `echo ${missing} 1>&2\r\n` +
                `echo ${repair} 1>&2\r\n` +
                `exit /b 127\r\n` +
                `:run\r\n` +
                `"${binaryPath}" %*\r\n`,
            );
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
            fs.writeFileSync(
              staging,
              `#!/bin/sh\n${marker}\n` +
                `if [ ! -x "${binaryPath}" ]; then\n` +
                `  echo "${missing}" >&2\n` +
                `  echo "${repair}" >&2\n` +
                `  exit 127\n` +
                `fi\n` +
                `exec "${binaryPath}" "$@"\n`,
            );
            fs.chmodSync(staging, 0o755);
          },
        },
      ];

  for (const target of targets) {
    try {
      if (fs.existsSync(target.path) && !isOwned(target.path, command)) {
        const foreignMarker = readMarker(target.path);
        if (foreignMarker && foreignMarker.command === command && foreignMarker.sha256 === sha256OfFile(target.path)) {
          // A shim owned by another home that still exists (orphans are
          // reclaimed by isOwned before this point): name the owner so the
          // user knows where the shim came from. Isolated homes only manage
          // their own bin directory, so the reliable cleanup is manual.
          logger.warn(
            `The ${command} shim at ${target.path} was created by offckb for a different plugin home (${foreignMarker.home}); ` +
              `leaving it untouched. Delete the shim and its .offckb marker manually to reclaim the name.`,
          );
        } else {
          logger.warn(
            `A file already exists at ${target.path} that was not created by offckb; leaving it untouched. ` +
              `Tools that call \`${command}\` directly will need it added to PATH manually.`,
          );
        }
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

/**
 * Remove offckb-owned shims only; foreign files (and stale markers beside
 * them) are left in place. Returns the paths that were removed.
 */
export function removeCommandShims(command: string): string[] {
  const removed: string[] = [];
  // Isolated homes only ever published into their own bin directory; the
  // global PATH was never touched, so nothing there may be removed here.
  const directory = publishDirectory();
  if (!directory) return removed;
  const isWindows = process.platform === 'win32';
  const candidates = isWindows
    ? [path.join(directory, `${command}.cmd`), path.join(directory, `${command}.exe`)]
    : [path.join(directory, command)];
  for (const target of candidates) {
    try {
      // Ownership re-verifies the recorded content hash, so a stale marker
      // next to a file the user replaced never authorizes deletion. Delete
      // the executable first: if its removal fails (e.g. an in-use Windows
      // .exe), the marker must survive so a later cleanup still owns it.
      if (!isOwned(target, command)) continue;
      fs.rmSync(target, { force: true });
      fs.rmSync(shimMarkerPath(target), { force: true });
      removed.push(target);
    } catch (error) {
      logger.warn(`Could not remove the ${command} shim at ${target}: ${(error as Error).message}.`);
    }
  }
  return removed;
}
