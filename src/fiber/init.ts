import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { readSettings, Settings } from '../cfg/setting';
import { logger } from '../util/logger';
import { resolveFnnBinary } from './install';
import {
  FiberManifest,
  FnnProgram,
  newNodeEntry,
  readFiberManifest,
  resolveNodeFile,
  validateManifest,
  validateNodeCount,
  writeManifest,
} from './nodes-yml';
import {
  DEFAULT_FIBER_NODES,
  MAX_FIBER_NODES,
  fiberNodeIds,
  fiberNodePaths,
  fiberRootPath,
  nodesYmlPath,
} from './paths';
import {
  assertNodeFundingKey,
  ensureNodeKeyMaterial,
  resolveFundingAccount,
  warnSharedAccounts,
  readNodePassword,
  readFiberNodeSecretKey,
  fiberPublicKeyFromSecret,
} from './accounts';
import { biscuitPaths, prepareBiscuit, validateBiscuitKeyPair, validateRpcToken } from './auth';
import { generateNodeConfig, validateNodeConfig, defaultConfigFile } from './config-gen';
import { readRegularFile, readYaml, writePrivateFile } from './files';
import { FiberChainScripts } from './scripts';

export interface FiberInitOptions {
  nodes?: number;
  add?: boolean;
  accountIndex?: number;
  randomAccount?: boolean;
  version?: string;
  binaryPath?: string;
}
export type PreparedFiberManifest = FiberManifest & { fnn: FnnProgram };
export function pendingInitFile(settings: Settings): string {
  return path.join(fiberRootPath(settings), 'init.pending.yml');
}

function assertProgram(program: FnnProgram) {
  try {
    if (!fs.statSync(program.binary_path).isFile()) throw new Error('not a file');
    fs.accessSync(program.binary_path, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  } catch {
    throw new Error(
      `Saved FNN program is missing or not executable: ${program.binary_path}. Restore it; OffCKB will not replace it automatically.`,
    );
  }
}
function assertProgramOptions(program: FnnProgram, options: FiberInitOptions) {
  if (
    (options.binaryPath && path.resolve(options.binaryPath) !== program.binary_path) ||
    (options.version && options.version !== program.version)
  ) {
    throw new Error(
      `FNN selection conflicts with the initialized environment (${program.binary_path}, version ${program.version ?? 'custom'}). Existing environments retain their saved program.`,
    );
  }
}
function assertDistinctPaths(manifest: FiberManifest, settings: Settings) {
  const owners = new Map<string, string>();
  for (const file of [nodesYmlPath(settings), pendingInitFile(settings)])
    owners.set(path.resolve(file), 'environment metadata');
  for (const node of manifest.nodes) {
    const paths = fiberNodePaths(node.id, settings);
    for (const file of [
      resolveNodeFile(node.config_file, settings),
      resolveNodeFile(node.rpc_token_file, settings),
      defaultConfigFile(node.id, settings),
      paths.ckbKeyFile,
      paths.passwordFile,
      paths.fiberSkFile,
      ...Object.values(biscuitPaths(node.id, settings)),
    ]) {
      const resolved = path.resolve(file);
      if (owners.has(resolved))
        throw new Error(`Fiber node ${node.id}: file path collides with ${owners.get(resolved)}: ${resolved}`);
      owners.set(resolved, `node ${node.id}`);
    }
  }
}
export async function validatePreparedNodes(
  manifest: PreparedFiberManifest,
  chain: FiberChainScripts,
  settings: Settings,
) {
  assertProgram(manifest.fnn);
  assertDistinctPaths(manifest, settings);
  for (const node of manifest.nodes) {
    if (!node.initialized) throw new Error(`Fiber node ${node.id} is not initialized. Run offckb fiber init.`);
    const required = [
      resolveNodeFile(node.config_file, settings),
      resolveNodeFile(node.rpc_token_file, settings),
      fiberNodePaths(node.id, settings).ckbKeyFile,
      fiberNodePaths(node.id, settings).passwordFile,
      ...(fs.existsSync(fiberNodePaths(node.id, settings).fiberStoreDir)
        ? [fiberNodePaths(node.id, settings).fiberSkFile]
        : []),
      ...Object.values(biscuitPaths(node.id, settings)),
    ];
    for (const file of required) {
      try {
        readRegularFile(file);
      } catch {
        throw new Error(
          `Fiber node ${node.id}: required file missing or unreadable: ${file}. Restore the original file; it will not be regenerated.`,
        );
      }
    }
    assertNodeFundingKey(node, settings);
    readNodePassword(node.id, settings);
    if (fs.existsSync(fiberNodePaths(node.id, settings).fiberSkFile)) {
      try {
        const identity = readFiberNodeSecretKey(node.id, settings);
        if (!identity) throw new Error('missing identity');
        fiberPublicKeyFromSecret(identity);
      } catch {
        throw new Error(
          `Fiber node ${node.id}: invalid network identity key in ${fiberNodePaths(node.id, settings).fiberSkFile}. Restore the original file.`,
        );
      }
    }
    const { publicKey } = validateNodeConfig(node, chain, settings);
    const storedPublicKey = await validateBiscuitKeyPair(node.id, settings);
    await validateRpcToken(resolveNodeFile(node.rpc_token_file, settings), publicKey ?? storedPublicKey);
  }
  warnSharedAccounts(manifest.nodes);
}

// Callers hold the devnet environment lock. A durable pending manifest owns
// only unfinished new nodes; completed nodes never have files repaired here.
export async function initializeFiberEnvironment(
  options: FiberInitOptions,
  chain: FiberChainScripts,
  settings: Settings = readSettings(),
  forStart = false,
): Promise<PreparedFiberManifest> {
  if (options.nodes != null && options.add) throw new Error('--nodes and --add are mutually exclusive.');
  if (options.accountIndex != null && options.randomAccount)
    throw new Error('--account-index and --random-account are mutually exclusive.');
  if ((options.accountIndex != null || options.randomAccount) && !options.add)
    throw new Error('Account flags require --add.');
  if (options.nodes != null) validateNodeCount(options.nodes);
  let manifest = readFiberManifest(settings);
  const pendingFile = pendingInitFile(settings);
  const resuming = fs.existsSync(pendingFile);
  if (resuming) {
    const pending = validateManifest(readYaml(pendingFile), pendingFile);
    if (
      options.nodes != null &&
      (pending.nodes.length !== options.nodes || pending.nodes.some((node) => node.id > options.nodes!))
    ) {
      throw new Error(`Requested node count conflicts with pending initialization. Resume it with offckb fiber init.`);
    }
    const additions = pending.nodes.filter((node) => !node.initialized);
    if (
      options.accountIndex != null &&
      (additions.length !== 1 ||
        additions[0].account.type !== 'builtin' ||
        additions[0].account.index !== options.accountIndex)
    ) {
      throw new Error('Requested account conflicts with pending initialization; the saved account will be retained.');
    }
    if (options.randomAccount && (additions.length !== 1 || additions[0].account.type !== 'random')) {
      throw new Error('Requested account conflicts with pending initialization; the saved account will be retained.');
    }
    // The registry may already have been committed before a crash removed
    // the journal. In that case finish the same operation, never append twice.
    if (
      manifest &&
      manifest.nodes.every((node) => node.initialized) &&
      JSON.stringify(manifest) ===
        JSON.stringify({ ...pending, nodes: pending.nodes.map((node) => ({ ...node, initialized: true })) })
    ) {
      fs.unlinkSync(pendingFile);
      assertProgramOptions(manifest.fnn!, options);
      await validatePreparedNodes(manifest as PreparedFiberManifest, chain, settings);
      return manifest as PreparedFiberManifest;
    }
    if (
      manifest &&
      JSON.stringify(manifest.nodes.filter((node) => node.initialized)) !==
        JSON.stringify(pending.nodes.filter((node) => node.initialized))
    ) {
      throw new Error(
        `Existing node records changed during initialization. Restore the original nodes.yml before resuming ${pendingFile}.`,
      );
    }
    manifest = pending;
  }
  const existingIds = fiberNodeIds(settings);
  if (!manifest && existingIds.length)
    throw new Error('Fiber node directories exist without nodes.yml; refusing to import or overwrite them.');
  if (options.add && (!manifest || !manifest.nodes.some((node) => node.initialized)))
    throw new Error('No Fiber environment. Run offckb fiber init or fiber start first.');
  if (!resuming && manifest) {
    for (const node of manifest.nodes.filter((entry) => !entry.initialized)) {
      if (existingIds.includes(node.id))
        throw new Error(
          `Unregistered node directory ${fiberNodePaths(node.id, settings).dir}; refusing to overwrite it.`,
        );
    }
  }
  if (!manifest)
    manifest = { nodes: Array.from({ length: options.nodes ?? DEFAULT_FIBER_NODES }, (_, i) => newNodeEntry(i + 1)) };
  else if (!resuming) {
    if (
      forStart &&
      options.nodes != null &&
      (manifest.nodes.length !== options.nodes || manifest.nodes.some((node) => node.id > options.nodes!))
    ) {
      throw new Error(
        'Requested node count conflicts with the initialized environment. Add nodes with offckb fiber init.',
      );
    }
    if (options.nodes != null) {
      if (manifest.nodes.some((node) => node.id > options.nodes!))
        throw new Error('--nodes cannot remove existing nodes.');
      for (let id = 1; id <= options.nodes; id++)
        if (!manifest.nodes.some((node) => node.id === id)) manifest.nodes.push(newNodeEntry(id));
    }
    if (options.add) {
      const id = Math.max(...manifest.nodes.map((node) => node.id), ...existingIds) + 1;
      if (id > MAX_FIBER_NODES || manifest.nodes.length >= MAX_FIBER_NODES)
        throw new Error('Fiber supports node ids 1 to 16; cannot append another node.');
      manifest.nodes.push(
        newNodeEntry(
          id,
          options.accountIndex != null
            ? { type: 'builtin', index: options.accountIndex }
            : options.randomAccount
              ? { type: 'random' }
              : undefined,
        ),
      );
    }
  }
  manifest.nodes.sort((a, b) => a.id - b.id);
  if (manifest.fnn) assertProgramOptions(manifest.fnn, options);
  else {
    const fnn = await resolveFnnBinary({ version: options.version, binaryPath: options.binaryPath }, settings);
    manifest.fnn = {
      binary_path: path.resolve(fnn.fnnPath),
      template_file: path.resolve(fnn.testnetConfigPath),
      version: fnn.version,
    };
  }
  assertProgram(manifest.fnn);
  assertDistinctPaths(manifest, settings);
  const prepared = manifest as PreparedFiberManifest;
  const newNodes = manifest.nodes.filter((node) => !node.initialized);
  // Check all completed nodes before making a provisioning journal.
  if (manifest.nodes.some((node) => node.initialized))
    await validatePreparedNodes(
      { ...prepared, nodes: manifest.nodes.filter((node) => node.initialized) },
      chain,
      settings,
    );
  if (!newNodes.length) return prepared;
  if (!resuming) {
    for (const node of newNodes) {
      if (existingIds.includes(node.id))
        throw new Error(`Node directory already exists: ${fiberNodePaths(node.id, settings).dir}`);
      if (node.account.type === 'random' && !node.account.key)
        node.account.key = `0x${crypto.randomBytes(32).toString('hex')}`;
      resolveFundingAccount(node.account);
      // New files must not overwrite unrelated configs or credentials.
      for (const file of [node.config_file, node.rpc_token_file])
        if (fs.existsSync(resolveNodeFile(file, settings)))
          throw new Error(`Refusing to overwrite existing file: ${resolveNodeFile(file, settings)}`);
    }
    writePrivateFile(pendingFile, yaml.dump(prepared, { noRefs: true }));
  } else assertProgramOptions(prepared.fnn, options);
  for (const node of newNodes) {
    ensureNodeKeyMaterial(node.id, settings, node.account, true);
    assertNodeFundingKey(node, settings);
    await prepareBiscuit(node, settings);
    generateNodeConfig({ node, chainScripts: chain, testnetConfigPath: prepared.fnn.template_file, settings });
  }
  const completed: PreparedFiberManifest = {
    ...prepared,
    nodes: prepared.nodes.map((node) => ({ ...node, initialized: true })),
  };
  await validatePreparedNodes(completed, chain, settings);
  writeManifest(completed, settings);
  fs.unlinkSync(pendingFile);
  for (const node of newNodes)
    logger.info(
      `Prepared Fiber node ${node.id}: config ${resolveNodeFile(node.config_file, settings)}, ${node.account.type === 'builtin' ? `account #${node.account.index}` : 'random account'} ${resolveFundingAccount(node.account).address}`,
    );
  return completed;
}
