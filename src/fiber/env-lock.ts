import * as fs from 'fs';
import * as path from 'path';
import { envLockPath } from './paths';
import { isProcessAlive } from '../util/daemon';
import { logger } from '../util/logger';

export interface EnvLockHandle {
  lockFile: string;
  release: () => void;
}

interface LockRecord {
  pid: number;
  acquiredAt: string;
}

// A held lock marks that this process is currently mutating the devnet
// environment (starting/stopping FNNs, cleaning data). It is released after
// the operation, not for the lifetime of the managed processes.
const heldLocks = new Set<string>();

function readLockRecord(lockFile: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as Partial<LockRecord>;
    if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0) {
      return { pid: parsed.pid as number, acquiredAt: String(parsed.acquiredAt ?? '') };
    }
  } catch {
    // Unreadable or invalid content: cannot identify a holder.
  }
  return null;
}

/**
 * Acquire the devnet environment lock. Throws when another live OffCKB
 * process holds it. A leftover lock whose recorded holder no longer exists
 * is removed and re-acquired; that is the only condition under which a stale
 * lock may be deleted.
 */
export function acquireEnvLock(purpose: string, lockFile: string = envLockPath()): EnvLockHandle {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw new Error(`Failed to acquire environment lock ${lockFile}: ${err.message}`);
      }
      const record = readLockRecord(lockFile);
      if (record) {
        let alive = false;
        try {
          alive = isProcessAlive(record.pid);
        } catch {
          alive = true; // cannot check → assume held, never break a live lock
        }
        if (alive) {
          throw new Error(
            `Another OffCKB process (PID ${record.pid}, since ${record.acquiredAt || 'unknown time'}) is ` +
              `modifying this devnet environment. Wait for it to finish before running: ${purpose}.`,
          );
        }
        logger.debug(`Removing stale environment lock left by dead process ${record.pid}.`);
      } else {
        logger.debug(`Removing unreadable environment lock file ${lockFile}.`);
      }
      try {
        fs.unlinkSync(lockFile);
      } catch (unlinkError) {
        throw new Error(`Failed to remove stale environment lock ${lockFile}: ${(unlinkError as Error).message}`);
      }
      continue;
    }

    try {
      const record: LockRecord = { pid: process.pid, acquiredAt: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(record));
    } finally {
      fs.closeSync(fd);
    }
    heldLocks.add(lockFile);
    return {
      lockFile,
      release: () => releaseEnvLock(lockFile),
    };
  }
  throw new Error(`Failed to acquire environment lock ${lockFile}.`);
}

export function releaseEnvLock(lockFile: string = envLockPath()) {
  if (!heldLocks.has(lockFile)) return;
  heldLocks.delete(lockFile);
  try {
    // Only delete the lock if it still records this process; never remove a
    // lock that another process re-acquired after us.
    const record = readLockRecord(lockFile);
    if (record == null || record.pid === process.pid) {
      fs.unlinkSync(lockFile);
    }
  } catch (error) {
    logger.warn(`Failed to release environment lock ${lockFile}: ${(error as Error).message}`);
  }
}

export function isEnvLockHeld(lockFile: string = envLockPath()): boolean {
  const record = readLockRecord(lockFile);
  if (record == null) return false;
  try {
    return isProcessAlive(record.pid);
  } catch {
    return true;
  }
}
