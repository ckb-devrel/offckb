import * as fs from 'fs';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';
import { acquireEnvLock } from './env-lock';
import { envLockPath, fiberDaemonPaths, fiberNodeIds, fiberNodePaths, fiberRootPath } from './paths';
import { readLiveRuntime, removeRuntimeFileIfStale } from './runtime';
import { readPidFile, isProcessAlive } from '../util/daemon';
import { isStoreLockHeld } from './store-lock';
import { readSettings, Settings } from '../cfg/setting';
import { isFolderExists } from '../util/fs';
import { logger } from '../util/logger';
import { readFiberManifest, resolveNodeFile } from './nodes-yml';

export interface FiberCleanOptions {
  data?: boolean;
  yes?: boolean;
}

function existingStoreLockFiles(settings: Settings): string[] {
  return fiberNodeIds(settings)
    .map((id) => fiberNodePaths(id, settings).storeLockFile)
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

function realPathOrResolved(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function containsPath(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Check every node against every deletion target before a data-only reset deletes anything. */
export function assertFiberFilesRetained(targets: string[], settings: Settings = readSettings()) {
  const manifest = readFiberManifest(settings);
  for (const node of manifest?.nodes ?? []) {
    for (const field of ['config_file', 'rpc_token_file'] as const) {
      const file = resolveNodeFile(node[field], settings);
      for (const target of targets) {
        if (
          containsPath(path.resolve(target), file) ||
          containsPath(realPathOrResolved(target), realPathOrResolved(file))
        ) {
          throw new Error(
            `Cannot reset data: Fiber node ${node.id} ${field} (${file}) is inside deletion target ${target}. ` +
              'Move the file outside the data directories and update nodes.yml before retrying. No data was deleted.',
          );
        }
      }
    }
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
  const lock = acquireEnvLock(options.data ? 'offckb fiber clean --data' : 'offckb fiber clean', envLockPath(settings));
  try {
    const root = fiberRootPath(settings);
    if (!isFolderExists(root)) {
      logger.info('Nothing to clean. No fiber environment found.');
      logger.result({ command: 'fiber.clean', cleaned: false, reason: 'not-found' });
      return;
    }

    assertFiberFullyStopped(settings);

    if (options.data) {
      const stores = fiberNodeIds(settings)
        .map((id) => fiberNodePaths(id, settings).fiberStoreDir)
        .filter((storeDir) => isFolderExists(storeDir));
      assertFiberFilesRetained(stores, settings);
      logger.warn(
        'This permanently deletes every FNN store (channels, payments and other node data). ' +
          'Deleted data cannot be recovered. Node accounts, identity keys, passwords, Biscuit keys, RPC tokens, configs and logs are kept. This is a data reset, not a restart.',
      );
      for (const store of stores) {
        logger.info(`  will delete: ${store}`);
      }
      await confirmOrAbort('Delete all FNN stores?', options.yes);

      // The confirmation prompt can sit open for an arbitrary time; re-verify
      // nothing started in that window before deleting anything.
      assertFiberFullyStopped(settings);
      assertFiberFilesRetained(stores, settings);
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
      'This deletes the Fiber environment under its directory, including node configs, the CKB account keys, ' +
        'the Fiber network identity keys and passwords of every node. Restarting creates NEW node identities. ' +
        'Files referenced outside this directory, the downloaded FNN binary and the devnet CKB data are kept.',
    );
    logger.info(`  will delete: ${root}`);
    await confirmOrAbort('Delete the whole fiber environment?', options.yes);

    // Same post-confirmation re-check as the --data path above.
    assertFiberFullyStopped(settings);
    fs.rmSync(root, { recursive: true, force: true });
    logger.success('Fiber environment cleaned.');
    logger.result({ command: 'fiber.clean', cleaned: true, dataOnly: false, removed: [root] });
  } finally {
    lock.release();
  }
}
