import { execFileSync } from 'child_process';
import * as fs from 'fs';

/**
 * Whether a RocksDB LOCK file is still held by a process. Returns null when
 * the check cannot be performed (missing lsof, inspection error), so callers
 * can refuse instead of guessing.
 *
 * RocksDB keeps the LOCK file open (and fcntl-locked) for the store's whole
 * lifetime, so "held open by a process" is the signal. Windows has no lsof;
 * there a self-rename fails while a process holds the file.
 */
export function isStoreLockHeld(lockFile: string): boolean | null {
  if (!fs.existsSync(lockFile)) {
    // No lock file means no store was ever opened (or it was removed);
    // nothing is holding it.
    return false;
  }
  if (process.platform === 'win32') {
    try {
      fs.renameSync(lockFile, lockFile);
      return false;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EPERM' || err.code === 'EBUSY') return true;
      return null;
    }
  }
  try {
    const stdout = execFileSync('lsof', ['--', lockFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf8',
    });
    // Exit 0: lsof printed every process holding the file on stdout.
    return stdout.trim().length > 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      status?: number | null;
      signal?: NodeJS.Signals | null;
    };
    if (err.code === 'ENOENT' || err.code === 'ETIMEDOUT') return null;
    // Only exit 1 is a genuine "no holder" answer — matches are printed on
    // stdout; stderr may carry unrelated warnings (e.g. an un-stat-able fuse
    // mount), so only stdout decides. A timeout kill (signal set) or any
    // other exit status is an inspection failure: report "unknown" (null)
    // rather than "free" (false), so cleanup refuses instead of deleting a
    // live store's metadata.
    if (err.signal != null || err.status !== 1) return null;
    const stdout = typeof err.stdout === 'string' ? err.stdout.trim() : null;
    return stdout == null ? null : stdout.length > 0;
  }
}

export async function waitForStoreLocksReleased(lockFiles: string[], timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let allReleased = true;
    for (const lockFile of lockFiles) {
      if (isStoreLockHeld(lockFile) !== false) {
        allReleased = false;
        break;
      }
    }
    if (allReleased) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}
