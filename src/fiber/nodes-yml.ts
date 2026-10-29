import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { nodesYmlPath, MAX_FIBER_NODES, MIN_FIBER_NODES, fiberAccountIndex } from './paths';
import { readSettings, Settings } from '../cfg/setting';
import { getBuiltinAccount, validatePrivateKey } from './accounts';
import { isMapping, readYaml, writePrivateFile } from './files';

export type FundingAccount = { type: 'builtin'; index: number } | { type: 'random'; key?: string };
export interface FiberNodeEntry {
  id: number;
  initialized: boolean;
  account: FundingAccount;
  config_file: string;
  rpc_token_file: string;
}
export interface FnnProgram {
  binary_path: string;
  template_file: string;
  version: string | null;
}
export interface FiberManifest {
  fnn?: FnnProgram;
  nodes: FiberNodeEntry[];
}

export function validateNodeCount(count: number): number {
  if (!Number.isInteger(count) || count < MIN_FIBER_NODES || count > MAX_FIBER_NODES) {
    throw new Error(`--nodes must be an integer between ${MIN_FIBER_NODES} and ${MAX_FIBER_NODES}, got: ${count}`);
  }
  return count;
}

export function newNodeEntry(id: number, account?: FundingAccount): FiberNodeEntry {
  return {
    id,
    initialized: false,
    account: account ?? { type: 'builtin', index: fiberAccountIndex(id) },
    config_file: `nodes/${id}/config.yml`,
    rpc_token_file: `nodes/${id}/rpc-token`,
  };
}

export function validateManifest(raw: unknown, file: string): FiberManifest {
  const fail = (reason: string): never => {
    throw new Error(`Invalid ${file}: ${reason}`);
  };
  if (!isMapping(raw) || !Array.isArray(raw.nodes)) return fail('expected a nodes list.');
  if (raw.nodes.length < 1 || raw.nodes.length > MAX_FIBER_NODES) return fail('expected 1 to 16 nodes.');
  const ids = new Set<number>();
  const nodes = raw.nodes.map((node: unknown, i: number): FiberNodeEntry => {
    if (!isMapping(node) || !Number.isInteger(node.id) || Number(node.id) < 1 || Number(node.id) > MAX_FIBER_NODES) {
      return fail(`nodes[${i}].id must be an integer between 1 and 16.`);
    }
    const id = Number(node.id);
    if (ids.has(id)) return fail(`duplicate node id ${id}.`);
    ids.add(id);
    if ('config' in node)
      return fail(`node ${id}: nodes[].config is unsupported; use config_file (no legacy migration).`);
    if (typeof node.initialized !== 'boolean') return fail(`node ${id}: initialized must be true or false.`);
    const defaults = newNodeEntry(id);
    let account: FundingAccount;
    if (node.account == null && !node.initialized) account = defaults.account;
    else if (isMapping(node.account) && node.account.type === 'builtin') {
      if (!Number.isInteger(node.account.index) || 'key' in node.account)
        return fail(`node ${id}: invalid builtin account.index/key.`);
      const index = Number(node.account.index);
      getBuiltinAccount(index);
      account = { type: 'builtin', index };
    } else if (isMapping(node.account) && node.account.type === 'random') {
      if ('index' in node.account) return fail(`node ${id}: random account cannot have index.`);
      if (node.account.key != null) validatePrivateKey(node.account.key, `node ${id} account.key`);
      if (node.initialized && node.account.key == null) return fail(`node ${id}: missing account.key.`);
      account = { type: 'random', ...(node.account.key == null ? {} : { key: String(node.account.key) }) };
    } else return fail(`node ${id}: invalid or missing account.`);
    const config = node.config_file ?? (!node.initialized ? defaults.config_file : undefined);
    const token = node.rpc_token_file ?? (!node.initialized ? defaults.rpc_token_file : undefined);
    if (typeof config !== 'string' || !config.trim()) return fail(`node ${id}: missing config_file.`);
    if (typeof token !== 'string' || !token.trim()) return fail(`node ${id}: missing rpc_token_file.`);
    return { id, initialized: node.initialized, account, config_file: config, rpc_token_file: token };
  });
  let fnn: FnnProgram | undefined;
  if (raw.fnn != null) {
    if (
      !isMapping(raw.fnn) ||
      typeof raw.fnn.binary_path !== 'string' ||
      !path.isAbsolute(raw.fnn.binary_path) ||
      typeof raw.fnn.template_file !== 'string' ||
      !path.isAbsolute(raw.fnn.template_file)
    ) {
      return fail('fnn.binary_path and fnn.template_file must be absolute paths.');
    }
    if (raw.fnn.version != null && typeof raw.fnn.version !== 'string')
      return fail('fnn.version must be a string or null.');
    fnn = {
      binary_path: raw.fnn.binary_path,
      template_file: raw.fnn.template_file,
      version: (raw.fnn.version as string | null) ?? null,
    };
  } else if (nodes.some((node) => node.initialized)) return fail('missing fnn program record.');
  return { ...(fnn ? { fnn } : {}), nodes: nodes.sort((a, b) => a.id - b.id) };
}
export function readFiberManifest(settings: Settings = readSettings()): FiberManifest | null {
  const file = nodesYmlPath(settings);
  return fs.existsSync(file) ? validateManifest(readYaml(file), file) : null;
}
export function readNodesYml(settings: Settings = readSettings()): FiberNodeEntry[] | null {
  return readFiberManifest(settings)?.nodes ?? null;
}
export function writeManifest(manifest: FiberManifest, settings: Settings = readSettings()) {
  writePrivateFile(nodesYmlPath(settings), yaml.dump(manifest, { noRefs: true }));
}
export function resolveNodeFile(file: string, settings: Settings = readSettings()): string {
  return path.resolve(path.dirname(nodesYmlPath(settings)), file);
}
