import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { ccc } from '@ckb-ccc/core';
import { callJsonRpc } from '../util/json-rpc';
import { logger } from '../util/logger';
import { readSettings, Settings } from '../cfg/setting';
import { fiberNodePaths, fiberRpcUrl, fiberRpcPort, fiberP2pPort, fiberAccountIndex, runtimeJsonPath } from './paths';
import { ensureNodesYml, FiberNodeEntry } from './nodes-yml';
import {
  ensureNodeKeyMaterial,
  fiberNodeAccount,
  readNodePassword,
  fiberPublicKeyFromSecret,
  readFiberNodeSecretKey,
} from './accounts';
import { generateNodeConfig } from './config-gen';
import { FiberChainScripts } from './scripts';
import { fnnNodeInfo, fnnConnectPeer, fnnListPeers, checkPortFree, FnnNodeInfo } from './rpc';
import { writeRuntime, readLiveRuntime, removeRuntimeFile, removeRuntimeFileIfStale, FiberRuntime } from './runtime';
import { closeFileDescriptors } from '../util/daemon';

export interface FnnProcessHandle {
  id: number;
  process: ChildProcess;
  rpcUrl: string;
  dir: string;
  logFile: string;
}

export interface FiberEnvironment {
  nodes: FnnProcessHandle[];
  nodeInfos: Map<number, FnnNodeInfo>;
  genesisHash: string;
}

const FNN_RPC_TIMEOUT_MS = 90_000;
const STOP_GRACE_TIMEOUT_MS = 10_000;

export class FiberStartupError extends Error {
  constructor(
    message: string,
    public readonly startedNodes: FnnProcessHandle[] = [],
  ) {
    super(message);
    this.name = 'FiberStartupError';
  }
}

/**
 * Refuse to touch the environment while another live OffCKB process manages
 * FNNs (foreground or daemon). A leftover runtime record whose manager is
 * dead is stale and discarded, never used to hunt processes.
 */
export function assertNoLiveFiberManager(settings: Settings = readSettings()) {
  const live = readLiveRuntime(settings);
  if (live) {
    throw new Error(
      `Fiber nodes are already managed by OffCKB process ${live.managerPid} (started ${live.startedAt || 'unknown'}). ` +
        'Stop that environment first (`offckb fiber stop` for a daemon, or Ctrl+C in its terminal).',
    );
  }
  removeRuntimeFileIfStale(settings);
}

async function assertFiberPortsFree(nodes: FiberNodeEntry[]) {
  const conflicts: string[] = [];
  for (const node of nodes) {
    const rpcPort = fiberRpcPort(node.id);
    const p2pPort = fiberP2pPort(node.id);
    if (!(await checkPortFree(rpcPort))) {
      conflicts.push(`node ${node.id} RPC port ${rpcPort}`);
    }
    if (!(await checkPortFree(p2pPort))) {
      conflicts.push(`node ${node.id} P2P port ${p2pPort}`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Fiber port conflict: ${conflicts.join('; ')} ${conflicts.length === 1 ? 'is' : 'are'} already in use. ` +
        'OffCKB does not stop processes it did not start; free the port(s) or stop the program using them.',
    );
  }
}

function spawnFnn(node: FiberNodeEntry, fnnPath: string, settings: Settings): FnnProcessHandle {
  const paths = fiberNodePaths(node.id, settings);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logFd = fs.openSync(paths.logFile, 'a');
  const password = readNodePassword(node.id, settings);
  const child = spawn(fnnPath, ['-d', paths.dir], {
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      // FNN stays silent without an explicit filter (EnvFilter::from_default_env);
      // respect a user-provided RUST_LOG, default to info otherwise. Its fmt
      // layer writes ANSI colors unless NO_COLOR is present — keep the log
      // files plain.
      RUST_LOG: process.env.RUST_LOG ?? 'info',
      NO_COLOR: process.env.NO_COLOR ?? '1',
      FIBER_SECRET_KEY_PASSWORD: password,
      LOG_PREFIX: `[fiber ${node.id}]`,
    },
  });
  // The child's stdio owns the fd now; close our copy so the file is only
  // held open by the FNN process.
  closeFileDescriptors(logFd);
  return { id: node.id, process: child, rpcUrl: fiberRpcUrl(node.id), dir: paths.dir, logFile: paths.logFile };
}

async function waitForAllNodeInfo(nodes: FnnProcessHandle[], timeoutMs: number): Promise<Map<number, FnnNodeInfo>> {
  const start = Date.now();
  const infos = new Map<number, FnnNodeInfo>();
  const pending = new Set(nodes.map((n) => n.id));
  const exited = new Map<number, { code: number | null; signal: NodeJS.Signals | null }>();
  for (const node of nodes) {
    node.process.once('exit', (code, signal) => exited.set(node.id, { code, signal }));
    node.process.once('error', () => exited.set(node.id, { code: null, signal: null }));
  }

  while (pending.size > 0 && Date.now() - start < timeoutMs) {
    for (const id of [...pending]) {
      if (exited.has(id)) {
        const node = nodes.find((n) => n.id === id)!;
        throw new FiberStartupError(
          `FNN node ${id} exited during startup (code=${exited.get(id)!.code ?? 'null'}, signal=${exited.get(id)!.signal ?? 'none'}). ` +
            `See its log: ${node.logFile}`,
          nodes,
        );
      }
      const node = nodes.find((n) => n.id === id)!;
      try {
        const info = await fnnNodeInfo(node.rpcUrl, 2000);
        infos.set(id, info);
        pending.delete(id);
      } catch {
        // RPC not up yet; keep polling while the child is alive.
      }
    }
    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (pending.size > 0) {
    const idList = [...pending].join(', ');
    const logs = nodes
      .filter((n) => pending.has(n.id))
      .map((n) => n.logFile)
      .join(', ');
    throw new FiberStartupError(`Timed out waiting for FNN RPC of node(s) ${idList}. See log(s): ${logs}`, nodes);
  }
  return infos;
}

async function assertChainConsistency(
  nodes: FnnProcessHandle[],
  nodeInfos: Map<number, FnnNodeInfo>,
  expectedGenesisHash: string,
  settings: Settings,
) {
  let ckbGenesis: string;
  try {
    ckbGenesis = String(await callJsonRpc(settings.devnet.rpcUrl, 'get_block_hash', ['0x0'], 5000)).toLowerCase();
  } catch (error) {
    throw new FiberStartupError(
      `Failed to read the genesis block hash from CKB RPC ${settings.devnet.rpcUrl}: ${(error as Error).message}`,
      nodes,
    );
  }
  const expected = expectedGenesisHash.toLowerCase();
  if (ckbGenesis !== expected) {
    throw new FiberStartupError(
      `Chain mismatch: the running CKB node's genesis (${ckbGenesis}) differs from the devnet spec's (${expected}). ` +
        'The devnet chain data and its spec are out of sync; stop CKB and the FNNs, run `offckb clean`, and start again.',
      nodes,
    );
  }
  for (const node of nodes) {
    const info = nodeInfos.get(node.id)!;
    if (String(info.chain_hash).toLowerCase() !== expected) {
      throw new FiberStartupError(
        `Chain mismatch: FNN node ${node.id} reports chain_hash ${info.chain_hash}, expected ${expected}.`,
        nodes,
      );
    }
  }
}

async function assertNodeIdentitiesAndFunds(
  nodes: FnnProcessHandle[],
  nodeInfos: Map<number, FnnNodeInfo>,
  settings: Settings,
) {
  const client = new ccc.ClientPublicTestnet({ url: settings.devnet.rpcUrl, fallbacks: [] });
  for (const node of nodes) {
    const info = nodeInfos.get(node.id)!;

    const secret = readFiberNodeSecretKey(node.id, settings);
    if (secret == null) {
      throw new FiberStartupError(`Fiber node ${node.id} has no usable fiber/sk identity key after startup.`, nodes);
    }
    const expectedPubkey = fiberPublicKeyFromSecret(secret);
    if (String(info.pubkey).toLowerCase() !== expectedPubkey) {
      throw new FiberStartupError(
        `Fiber node ${node.id} reports an unexpected network identity (${info.pubkey}); ` +
          'the process answering on its RPC port is not the node OffCKB started.',
        nodes,
      );
    }

    const account = fiberNodeAccount(node.id);
    const expectedLock = account.lockScript;
    const actualLock = info.default_funding_lock_script;
    const lockMatches =
      actualLock &&
      actualLock.code_hash.toLowerCase() === expectedLock.codeHash.toLowerCase() &&
      actualLock.hash_type.toLowerCase() === expectedLock.hashType.toLowerCase() &&
      actualLock.args.toLowerCase() === expectedLock.args.toLowerCase();
    if (!lockMatches) {
      throw new FiberStartupError(
        `Fiber node ${node.id} funds account mismatch: expected built-in account #${fiberAccountIndex(node.id)} ` +
          `(lock args ${expectedLock.args}) but the node reports ${JSON.stringify(actualLock)}.`,
        nodes,
      );
    }

    let balance: bigint;
    try {
      balance = await client.getBalanceSingle(ccc.Script.from(account.lockScript as ccc.ScriptLike));
    } catch (error) {
      throw new FiberStartupError(
        `Failed to query the CKB balance of fiber node ${node.id}'s account: ${(error as Error).message}`,
        nodes,
      );
    }
    if (balance <= BigInt(0)) {
      throw new FiberStartupError(
        `Fiber node ${node.id}'s CKB account #${fiberAccountIndex(node.id)} has no available CKB. ` +
          'Fund the account before starting Fiber.',
        nodes,
      );
    }
    logger.info(
      `Fiber node ${node.id}: account #${fiberAccountIndex(node.id)} balance ${ccc.fixedPointToString(balance)} CKB.`,
    );
  }
}

async function connectFiberPeers(nodes: FnnProcessHandle[], nodeInfos: Map<number, FnnNodeInfo>) {
  if (nodes.length < 2) return;
  const [first, ...rest] = nodes;
  for (const peer of rest) {
    const info = nodeInfos.get(peer.id)!;
    const address = info.addresses.find((addr) => addr.includes('/p2p/'));
    if (!address) {
      throw new FiberStartupError(`FNN node ${peer.id} did not announce a connectable address.`, nodes);
    }
    try {
      await fnnConnectPeer(first.rpcUrl, address);
    } catch (error) {
      throw new FiberStartupError(
        `Failed to connect fiber node ${first.id} to node ${peer.id} at ${address}: ${(error as Error).message}`,
        nodes,
      );
    }
  }
  // connect_peer returns once dialing starts; give the P2P handshake a moment
  // to settle, then verify once with list_peers.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const peers = await fnnListPeers(first.rpcUrl);
  if (peers.length < rest.length) {
    throw new FiberStartupError(
      `Fiber node ${first.id} has ${peers.length} peer(s) after connect_peer, expected at least ${rest.length}.`,
      nodes,
    );
  }
  logger.info(`Fiber node ${first.id} connected to ${rest.length} peer(s).`);
}

export interface StartFiberEnvironmentOptions {
  fnnPath: string;
  testnetConfigPath: string;
  chainScripts: FiberChainScripts;
  nodeCount?: number;
  settings?: Settings;
}

/**
 * The shared Fiber startup flow used by both `offckb fiber start` and
 * `offckb node --fiber`: regenerate node configs from the current chain
 * spec, spawn all FNNs with their own logs, wait for their RPCs, verify the
 * chain/identity/account checks and interconnect the nodes. On any failure
 * the FNNs started here are stopped again.
 */
export async function startFiberEnvironment(options: StartFiberEnvironmentOptions): Promise<FiberEnvironment> {
  const settings = options.settings ?? readSettings();
  assertNoLiveFiberManager(settings);

  const nodes = ensureNodesYml(options.nodeCount, settings);
  for (const node of nodes) {
    const { created } = ensureNodeKeyMaterial(node.id, settings);
    if (created) {
      logger.info(`Fiber node ${node.id}: provisioned new CKB key and password.`);
    }
    generateNodeConfig({
      node,
      chainScripts: options.chainScripts,
      testnetConfigPath: options.testnetConfigPath,
      settings,
    });
  }
  await assertFiberPortsFree(nodes);

  const handles = nodes.map((node) => spawnFnn(node, options.fnnPath, settings));
  const runtime: FiberRuntime = {
    managerPid: process.pid,
    startedAt: new Date().toISOString(),
    status: 'starting',
    nodes: handles.map((handle) => ({
      id: handle.id,
      pid: handle.process.pid ?? 0,
      dir: handle.dir,
      rpcUrl: handle.rpcUrl,
    })),
  };
  writeRuntime(runtime, settings);

  try {
    const nodeInfos = await waitForAllNodeInfo(handles, FNN_RPC_TIMEOUT_MS);
    await assertChainConsistency(handles, nodeInfos, options.chainScripts.genesisHash, settings);
    await assertNodeIdentitiesAndFunds(handles, nodeInfos, settings);
    await connectFiberPeers(handles, nodeInfos);
    writeRuntime({ ...runtime, status: 'running' }, settings);
    return { nodes: handles, nodeInfos, genesisHash: options.chainScripts.genesisHash };
  } catch (error) {
    await stopFiberNodes(handles, settings);
    if (error instanceof FiberStartupError) {
      throw new FiberStartupError(error.message, []);
    }
    throw error;
  }
}

/**
 * Stop the given FNN child processes: one SIGTERM, wait for exit, a single
 * SIGKILL if the grace period expires. Removes runtime.json when this process
 * is the recorded manager. Never touches processes it was not handed.
 */
export async function stopFiberNodes(nodes: FnnProcessHandle[], settings: Settings = readSettings()): Promise<void> {
  for (const node of nodes) {
    if (node.process.exitCode == null && !node.process.killed) {
      try {
        node.process.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  const deadline = Date.now() + STOP_GRACE_TIMEOUT_MS;
  for (const node of nodes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitForChildExit(node.process, remaining);
  }
  for (const node of nodes) {
    if (node.process.exitCode == null) {
      try {
        node.process.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  removeRuntimeFileIfManager(settings);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function removeRuntimeFileIfManager(settings: Settings) {
  try {
    const raw = fs.readFileSync(runtimeJsonPath(settings), 'utf8');
    const parsed = JSON.parse(raw) as { managerPid?: number };
    if (parsed.managerPid === process.pid) {
      removeRuntimeFile(settings);
    }
  } catch {
    // no runtime file or unreadable — nothing to do
  }
}
