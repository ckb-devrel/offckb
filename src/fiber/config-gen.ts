import * as fs from 'fs';
import yaml from 'js-yaml';
import { fiberNodePaths, fiberP2pAddr, fiberRpcPort } from './paths';
import { FiberChainScripts } from './scripts';
import { FiberNodeEntry } from './nodes-yml';
import { readSettings, Settings } from '../cfg/setting';

// The devnet spec file, resolved by FNN relative to the node directory
// (<devnet>/fiber/nodes/<id>/). The specs directory is shared, so the config
// points at the original dev.toml instead of copying it per node.
const DEV_TOML_RELATIVE_TO_NODE = '../../../specs/dev.toml';

// RPC modules the devnet environment serves. cch is intentionally off, and
// dev-only modules (only available in debug builds) are not relied upon.
const ENABLED_RPC_MODULES = ['channel', 'payment', 'graph', 'info', 'invoice', 'peer', 'watchtower'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Deep-merge per-node overrides onto the generated config: objects merge
// recursively, lists replace wholesale (matching FNN's own config layering).
export function mergeNodeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = mergeNodeConfig(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Generate one node's config.yml. The template is the testnet config bundled
 * with the FNN release, parsed as a generic mapping so config fields added by
 * future FNN versions survive the round trip. Chain- and environment-specific
 * values are replaced with the devnet ones; everything else is kept.
 *
 * Hand edits to config.yml do not survive regeneration — persistent
 * customization belongs in fiber/nodes.yml.
 */
export function generateNodeConfig(options: {
  node: FiberNodeEntry;
  chainScripts: FiberChainScripts;
  testnetConfigPath: string;
  settings?: Settings;
}): string {
  const settings = options.settings ?? readSettings();
  const nodeId = options.node.id;

  let template: unknown;
  try {
    template = yaml.load(fs.readFileSync(options.testnetConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse FNN testnet config ${options.testnetConfigPath}: ${(error as Error).message}`);
  }
  if (!isPlainObject(template)) {
    throw new Error(`FNN testnet config ${options.testnetConfigPath} is not a YAML mapping.`);
  }

  const fiber = isPlainObject(template.fiber) ? { ...template.fiber } : {};
  fiber.chain = DEV_TOML_RELATIVE_TO_NODE;
  fiber.listening_addr = fiberP2pAddr(nodeId);
  fiber.bootnode_addrs = [];
  fiber.announce_listening_addr = true;
  fiber.announce_private_addr = true;
  fiber.gossip_network_maintenance_interval_ms = 1000;
  fiber.gossip_store_maintenance_interval_ms = 1000;
  const nodeName = `offckb-fnn-${nodeId}`;
  if (Buffer.byteLength(nodeName, 'utf8') > 32) {
    throw new Error(`Fiber node name "${nodeName}" exceeds 32 UTF-8 bytes.`);
  }
  fiber.announced_node_name = nodeName;
  fiber.scripts = options.chainScripts.fiberScripts;

  const rpc = isPlainObject(template.rpc) ? { ...template.rpc } : {};
  rpc.listening_addr = `127.0.0.1:${fiberRpcPort(nodeId)}`;
  rpc.enabled_modules = ENABLED_RPC_MODULES;
  rpc.cors_enabled = false;

  const ckb = isPlainObject(template.ckb) ? { ...template.ckb } : {};
  ckb.rpc_url = settings.devnet.rpcUrl;
  ckb.udt_whitelist = options.chainScripts.udtWhitelist;

  let config: Record<string, unknown> = {
    ...template,
    fiber,
    rpc,
    ckb,
    services: ['fiber', 'rpc', 'ckb'],
  };
  config = mergeNodeConfig(config, options.node.config);

  const paths = fiberNodePaths(nodeId, settings);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump(config, { noRefs: true, lineWidth: -1 }));
  return paths.configFile;
}
