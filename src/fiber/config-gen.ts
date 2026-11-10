import * as fs from 'fs';
import yaml from 'js-yaml';
import { fiberNodePaths, fiberP2pAddr, fiberRpcPort } from './paths';
import { FiberChainScripts } from './scripts';
import { FiberNodeEntry, resolveNodeFile } from './nodes-yml';
import { isDeepStrictEqual } from 'util';
import path from 'path';
import { isMapping, readYaml, writePrivateFile } from './files';
import { readSettings, Settings } from '../cfg/setting';

// The devnet spec file, resolved by FNN relative to the node directory
// (<devnet>/fiber/nodes/<id>/). The specs directory is shared, so the config
// points at the original dev.toml instead of copying it per node.
const DEV_TOML_RELATIVE_TO_NODE = '../../../specs/dev.toml';

// RPC modules the devnet environment serves. cch is intentionally off, and
// dev-only modules (only available in debug builds) are not relied upon.
const ENABLED_RPC_MODULES = ['channel', 'payment', 'graph', 'info', 'invoice', 'peer', 'watchtower'];

/**
 * Generate one node's config.yml. The template is the testnet config bundled
 * with the FNN release, parsed as a generic mapping so config fields added by
 * future FNN versions survive the round trip. Chain- and environment-specific
 * values are replaced with the devnet ones; everything else is kept.
 *
 * Called only while preparing a new node; startup never writes configs.
 */
export function defaultNodeConfig(options: {
  node: FiberNodeEntry;
  chainScripts: FiberChainScripts;
  testnetConfigPath: string;
  settings?: Settings;
}): Record<string, unknown> {
  const settings = options.settings ?? readSettings();
  const nodeId = options.node.id;

  let template: unknown;
  try {
    template = yaml.load(fs.readFileSync(options.testnetConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse FNN testnet config ${options.testnetConfigPath}: ${(error as Error).message}`);
  }
  if (!isMapping(template)) {
    throw new Error(`FNN testnet config ${options.testnetConfigPath} is not a YAML mapping.`);
  }

  const fiber = isMapping(template.fiber) ? { ...template.fiber } : {};
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

  const rpc = isMapping(template.rpc) ? { ...template.rpc } : {};
  rpc.listening_addr = `127.0.0.1:${fiberRpcPort(nodeId)}`;
  rpc.enabled_modules = ENABLED_RPC_MODULES;
  rpc.cors_enabled = false;

  const ckb = isMapping(template.ckb) ? { ...template.ckb } : {};
  ckb.rpc_url = settings.devnet.rpcUrl;
  ckb.udt_whitelist = options.chainScripts.udtWhitelist;

  const config: Record<string, unknown> = {
    ...template,
    fiber,
    rpc,
    ckb,
    services: ['fiber', 'rpc', 'ckb'],
  };
  return config;
}

export function generateNodeConfig(options: Parameters<typeof defaultNodeConfig>[0]): string {
  const settings = options.settings ?? readSettings();
  const node = options.node;
  const config = defaultNodeConfig(options);
  const file = resolveNodeFile(node.config_file, settings);
  const baseline = defaultConfigFile(node.id, settings);
  if (!fs.existsSync(baseline)) writePrivateFile(baseline, yaml.dump(config, { noRefs: true, lineWidth: -1 }));
  if (!fs.existsSync(file)) writePrivateFile(file, readRegularConfigText(baseline));
  return file;
}
function readRegularConfigText(file: string): string {
  const config = readYaml(file);
  if (!isMapping(config)) throw new Error(`Invalid FNN config: ${file}`);
  return yaml.dump(config, { noRefs: true, lineWidth: -1 });
}
export function defaultConfigFile(id: number, settings: Settings = readSettings()): string {
  return path.join(fiberNodePaths(id, settings).dir, 'config.default.yml');
}
export type CustomConfig = 'yes' | 'no' | 'unknown';
export function customConfig(node: FiberNodeEntry, settings: Settings = readSettings()): CustomConfig {
  try {
    const baseline = readYaml(defaultConfigFile(node.id, settings));
    const actual = readYaml(resolveNodeFile(node.config_file, settings));
    if (
      !isMapping(baseline) ||
      !isMapping(actual) ||
      !isMapping(baseline.fiber) ||
      !isMapping(baseline.rpc) ||
      !isMapping(baseline.ckb) ||
      !Array.isArray(baseline.services)
    )
      return 'unknown';
    return isDeepStrictEqual(baseline, actual) ? 'no' : 'yes';
  } catch {
    return 'unknown';
  }
}
export function readNodeConfig(node: FiberNodeEntry, settings: Settings = readSettings()): Record<string, unknown> {
  const file = resolveNodeFile(node.config_file, settings);
  const config = readYaml(file);
  if (!isMapping(config)) throw new Error(`Fiber node ${node.id}: ${file} must be a YAML mapping.`);
  return config;
}
export function validateNodeConfig(node: FiberNodeEntry, chain: FiberChainScripts, settings: Settings) {
  const config = readNodeConfig(node, settings);
  const file = resolveNodeFile(node.config_file, settings);
  const fail = (field: string): never => {
    throw new Error(
      `Fiber node ${node.id}: invalid ${field} in ${file}; it must support OffCKB's local environment and management RPC.`,
    );
  };
  const fiber = isMapping(config.fiber) ? config.fiber : fail('fiber');
  const rpc = isMapping(config.rpc) ? config.rpc : fail('rpc');
  const ckb = isMapping(config.ckb) ? config.ckb : fail('ckb');
  if (
    !Array.isArray(config.services) ||
    !['fiber', 'rpc', 'ckb'].every((service) => (config.services as unknown[]).includes(service))
  )
    fail('services');
  if (
    !Array.isArray(rpc.enabled_modules) ||
    !['info', 'peer'].every((name) => (rpc.enabled_modules as unknown[]).includes(name))
  )
    fail('rpc.enabled_modules');
  if (rpc.listening_addr !== `127.0.0.1:${fiberRpcPort(node.id)}`) fail('rpc.listening_addr');
  if (fiber.listening_addr !== fiberP2pAddr(node.id)) fail('fiber.listening_addr');
  if (
    typeof fiber.chain !== 'string' ||
    path.resolve(fiberNodePaths(node.id, settings).dir, fiber.chain) !==
      path.join(settings.devnet.configPath, 'specs/dev.toml')
  )
    fail('fiber.chain');
  if (!isDeepStrictEqual(fiber.scripts, chain.fiberScripts)) fail('fiber.scripts');
  if (!isDeepStrictEqual(fiber.bootnode_addrs, [])) fail('fiber.bootnode_addrs');
  if (
    fiber.store_path != null &&
    (typeof fiber.store_path !== 'string' ||
      path.resolve(fiberNodePaths(node.id, settings).dir, fiber.store_path) !==
        fiberNodePaths(node.id, settings).fiberStoreDir)
  )
    fail('fiber.store_path');
  if (ckb.rpc_url !== settings.devnet.rpcUrl) fail('ckb.rpc_url');
  if (
    rpc.biscuit_public_key != null &&
    (typeof rpc.biscuit_public_key !== 'string' || !/^ed25519\/[0-9a-f]{64}$/i.test(rpc.biscuit_public_key))
  )
    fail('rpc.biscuit_public_key');
  return { config, publicKey: rpc.biscuit_public_key as string | undefined };
}
