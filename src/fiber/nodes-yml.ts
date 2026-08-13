import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { nodesYmlPath, fiberNodeDir, MIN_FIBER_NODES, MAX_FIBER_NODES, DEFAULT_FIBER_NODES } from './paths';
import { readSettings, Settings } from '../cfg/setting';
import { logger } from '../util/logger';

export interface FiberNodeEntry {
  id: number;
  // Per-node FNN config overrides, merged on top of the generated config.
  // Objects merge recursively, lists replace.
  config: Record<string, unknown>;
}

// These fields are owned by offckb; setting them per node would break the
// environment in ways the startup checks cannot recover from. fiber.store_path
// is managed so the store always lives where fiberNodePaths points — a
// relocated store would make clean's RocksDB LOCK check inspect the wrong
// path and silently lose its fail-closed property.
export const MANAGED_CONFIG_PATHS = [
  'fiber.chain',
  'fiber.scripts',
  'fiber.listening_addr',
  'fiber.bootnode_addrs',
  'fiber.store_path',
  'rpc.listening_addr',
  'ckb.rpc_url',
  'ckb.udt_whitelist',
  'services',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function validateNodeCount(count: number): number {
  if (!Number.isInteger(count) || count < MIN_FIBER_NODES || count > MAX_FIBER_NODES) {
    throw new Error(`--nodes must be an integer between ${MIN_FIBER_NODES} and ${MAX_FIBER_NODES}, got: ${count}`);
  }
  return count;
}

function assertNoManagedFields(config: Record<string, unknown>, nodeId: number) {
  for (const dottedPath of MANAGED_CONFIG_PATHS) {
    const segments = dottedPath.split('.');
    let current: unknown = config;
    for (const segment of segments) {
      if (!isPlainObject(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (current !== undefined) {
      throw new Error(
        `nodes.yml: node ${nodeId} sets "${dottedPath}", which is managed by offckb and cannot be overridden. ` +
          `Managed fields: ${MANAGED_CONFIG_PATHS.join(', ')}.`,
      );
    }
  }
}

export function readNodesYml(settings: Settings = readSettings()): FiberNodeEntry[] | null {
  const file = nodesYmlPath(settings);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.nodes)) {
    throw new Error(`Invalid ${file}: expected a "nodes" list. Fix the file or remove the fiber environment.`);
  }
  const entries: FiberNodeEntry[] = parsed.nodes.map((raw: unknown, index: number) => {
    if (!isPlainObject(raw) || !Number.isInteger(raw.id) || (raw.id as number) <= 0) {
      throw new Error(`Invalid ${file}: nodes[${index}] must have a positive integer "id".`);
    }
    const config = raw.config == null ? {} : raw.config;
    if (!isPlainObject(config)) {
      throw new Error(`Invalid ${file}: nodes[${index}].config must be a mapping of FNN config fields.`);
    }
    return { id: raw.id as number, config: config as Record<string, unknown> };
  });
  const ids = new Set<number>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Invalid ${file}: duplicate node id ${entry.id}.`);
    }
    if (entry.id > MAX_FIBER_NODES) {
      throw new Error(`Invalid ${file}: node id ${entry.id} exceeds the maximum of ${MAX_FIBER_NODES}.`);
    }
    ids.add(entry.id);
    assertNoManagedFields(entry.config, entry.id);
  }
  if (entries.length > MAX_FIBER_NODES) {
    throw new Error(`Invalid ${file}: ${entries.length} nodes configured, at most ${MAX_FIBER_NODES} are supported.`);
  }
  return entries.sort((a, b) => a.id - b.id);
}

export function writeNodesYml(entries: FiberNodeEntry[], settings: Settings = readSettings()) {
  const file = nodesYmlPath(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = {
    nodes: entries.map((entry) => ({ id: entry.id, config: entry.config })),
  };
  fs.writeFileSync(file, yaml.dump(doc, { noRefs: true }));
}

/**
 * Resolve the node list for this start. Without an existing nodes.yml one is
 * created from the requested count (default 2). With an existing file the
 * stored list wins unless --nodes asks for a different count: surviving ids
 * keep their per-node config, new ids start empty, and removed ids are
 * reported (their directories are never deleted automatically).
 */
export function ensureNodesYml(
  requestedCount: number | undefined,
  settings: Settings = readSettings(),
): FiberNodeEntry[] {
  const existing = readNodesYml(settings);
  if (existing == null) {
    const count = requestedCount == null ? DEFAULT_FIBER_NODES : validateNodeCount(requestedCount);
    const entries = Array.from({ length: count }, (_, i) => ({ id: i + 1, config: {} }));
    writeNodesYml(entries, settings);
    logger.debug(`Created ${nodesYmlPath(settings)} with ${count} node(s).`);
    return entries;
  }

  if (requestedCount == null) return existing;

  const count = validateNodeCount(requestedCount);
  if (count === existing.length && existing.every((entry, i) => entry.id === i + 1)) {
    return existing;
  }

  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const next: FiberNodeEntry[] = [];
  for (let id = 1; id <= count; id++) {
    next.push(byId.get(id) ?? { id, config: {} });
  }
  const removed = existing.filter((entry) => entry.id > count);
  for (const entry of removed) {
    logger.warn(
      `Node ${entry.id} is removed from nodes.yml; its per-node config overrides are discarded. ` +
        `Its directory ${fiberNodeDir(entry.id, settings)} is kept; ` +
        'delete it manually or run `offckb fiber clean` to remove it.',
    );
  }
  writeNodesYml(next, settings);
  return next;
}
