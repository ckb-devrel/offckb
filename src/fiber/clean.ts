import * as fs from 'fs';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import { acquireEnvLock } from './env-lock';
import { fiberDaemonPaths, fiberNodePaths, fiberRootPath } from './paths';
import { readLiveRuntime, removeRuntimeFileIfStale } from './runtime';
import { readPidFile, isProcessAlive } from '../util/daemon';
import { isStoreLockHeld } from './store-lock';
import { readSettings, Settings } from '../cfg/setting';
import { isFolderExists } from '../util/fs';
import { logger } from '../util/logger';

export interface FiberCleanOptions {
  data?: boolean;
  yes?: boolean;
}

function existingStoreLockFiles(settings: Settings): string[] {
  const nodesDir = path.join(fiberRootPath(settings), 'nodes');
  if (!isFolderExists(nodesDir)) return [];
  return fs
    .readdirSync(nodesDir)
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => fiberNodePaths(Number(entry), settings).storeLockFile)
    .filter((lockFile) => fs.existsSync(lockFile));
}

/**
 * Cleaning is only allowed when every FNN is stopped: no live manager
 * (daemon or foreground) and every existing store lock acquirable. Anything
 * that cannot be confirmed refuses the clean — a running FNN must never
 * watch its store disappear.
 */
export function assertFiberFullyStopped(settings: Settings = readSettings()) {
  const live = readLiveRuntime(settings);
  if (live) {
    throw new Error(
      `Fiber nodes are still managed by OffCKB process ${live.managerPid}. ` +
        'Stop them first (`offckb fiber stop` for a daemon, or Ctrl+C in its terminal).',
    );
  }
  const { pidFile } = fiberDaemonPaths(settings);
  const daemon = readPidFile(pidFile);
  if (daemon && Number.isInteger(daemon.pid) && daemon.pid > 0 && isProcessAlive(daemon.pid)) {
    throw new Error(`A fiber daemon is still running (PID ${daemon.pid}). Stop it first with: offckb fiber stop`);
  }

  const heldLocks = existingStoreLockFiles(settings).filter((lockFile) => isStoreLockHeld(lockFile) !== false);
  if (heldLocks.length > 0) {
    throw new Error(
      `Cannot confirm all Fiber stores are closed (lock(s) still held or unverifiable: ${heldLocks.join(', ')}). ` +
        'Stop every FNN process and try again.',
    );
  }
}

async function confirmOrAbort(message: string, yes?: boolean) {
  if (yes) return;
  const answer = await confirm({ message, default: false });
  if (!answer) {
    throw new Error('Aborted.');
  }
}

export async function fiberClean(options: FiberCleanOptions, settings: Settings = readSettings()) {
  const lock = acquireEnvLock(options.data ? 'offckb fiber clean --data' : 'offckb fiber clean');
  try {
    const root = fiberRootPath(settings);
    if (!isFolderExists(root)) {
      logger.info('Nothing to clean. No fiber environment found.');
      logger.result({ command: 'fiber.clean', cleaned: false, reason: 'not-found' });
      return;
    }

    assertFiberFullyStopped(settings);

    if (options.data) {
      const nodesDir = path.join(root, 'nodes');
      const stores = isFolderExists(nodesDir)
        ? fs
            .readdirSync(nodesDir)
            .filter((entry) => /^\d+$/.test(entry))
            .map((entry) => fiberNodePaths(Number(entry), settings).fiberStoreDir)
            .filter((storeDir) => isFolderExists(storeDir))
        : [];
      logger.warn(
        'This permanently deletes every FNN store (channels, payments and other node data). ' +
          'Deleted data cannot be recovered. Node accounts, identity keys, passwords and logs are kept.',
      );
      for (const store of stores) {
        logger.info(`  will delete: ${store}`);
      }
      await confirmOrAbort('Delete all FNN stores?', options.yes);

      removeRuntimeFileIfStale(settings);
      for (const store of stores) {
        fs.rmSync(store, { recursive: true, force: true });
        logger.info(`Deleted ${store}`);
      }
      logger.success('All FNN stores cleaned. Node accounts and network identities are unchanged.');
      logger.result({ command: 'fiber.clean', cleaned: true, dataOnly: true, removed: stores });
      return;
    }

    logger.warn(
      'This deletes the whole fiber environment, including node configs, the CKB account keys, ' +
        'the Fiber network identity keys and passwords of every node. Restarting creates NEW node identities. ' +
        'The downloaded FNN binary and the devnet CKB data are kept.',
    );
    logger.info(`  will delete: ${root}`);
    await confirmOrAbort('Delete the whole fiber environment?', options.yes);

    fs.rmSync(root, { recursive: true, force: true });
    logger.success('Fiber environment cleaned.');
    logger.result({ command: 'fiber.clean', cleaned: true, dataOnly: false, removed: [root] });
  } finally {
    lock.release();
  }
}
