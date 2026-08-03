import * as fs from 'fs';
import * as path from 'path';
import { checkNodeReadiness } from '../devnet/readiness';
import { readForkState, FORK_STATE_FILE } from '../devnet/fork';
import { callJsonRpc } from '../util/json-rpc';
import { readSettings, Settings } from '../cfg/setting';

// Fiber commands only work on a plain local devnet. A forked devnet keeps its
// source chain's data in the same directory and records the fork in
// fork.json, so the file's mere presence — valid or not — rejects Fiber.
export function assertPlainDevnet(settings: Settings = readSettings()) {
  const forkFile = path.join(settings.devnet.configPath, FORK_STATE_FILE);
  if (!fs.existsSync(forkFile)) return;
  const forkState = readForkState(settings.devnet.configPath);
  if (forkState) {
    throw new Error(
      `Fiber is not supported on a forked devnet (fork of ${forkState.source}, recorded in ${forkFile}). ` +
        'Run `offckb clean` and start a plain local chain to use Fiber.',
    );
  }
  throw new Error(
    `${forkFile} exists but cannot be read or parsed; cannot verify this is a plain local chain. ` +
      'Refusing to start Fiber. Remove the file only if you are sure this devnet is not a fork.',
  );
}

function parseHexNumber(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  return BigInt(value);
}

/**
 * `fiber start` requires a healthy local CKB environment it must not create
 * or replace itself: RPC answering, indexer answering, and the chain still
 * producing blocks.
 */
export async function assertCkbEnvReadyForFiber(settings: Settings = readSettings()) {
  const readiness = await checkNodeReadiness(settings.devnet.rpcUrl, 2000);
  if (!readiness.ready) {
    throw new Error(
      `The local CKB node is not answering at ${settings.devnet.rpcUrl}: ${readiness.error ?? 'unavailable'}. ` +
        'Start it first with `offckb node` (or use `offckb node --fiber` to start everything at once).',
    );
  }
  if (readiness.indexerTip == null) {
    throw new Error(
      `The CKB indexer is not ready at ${settings.devnet.rpcUrl}. Fiber needs the indexer; ` +
        'wait for the node to finish starting and try again.',
    );
  }

  const firstTip = readiness.nodeTip ?? BigInt(0);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const tip = parseHexNumber(await callJsonRpc(settings.devnet.rpcUrl, 'get_tip_block_number', [], 2000));
      if (tip != null && tip > firstTip) {
        return;
      }
    } catch {
      // keep waiting until the deadline
    }
  }
  throw new Error(
    `The CKB devnet at ${settings.devnet.rpcUrl} is not producing blocks. ` +
      'Fiber requires a mining devnet; check the node and miner (e.g. `offckb logs`).',
  );
}
