import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { fiberNodePaths } from '../src/fiber/paths';
import { generateNodeConfig, mergeNodeConfig } from '../src/fiber/config-gen';
import { FiberChainScripts } from '../src/fiber/scripts';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function fixture(): { settings: Settings; testnetConfigPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-config-'));
  tempRoots.push(root);
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.configPath = path.join(root, 'devnet');
  settings.devnet.rpcUrl = 'http://127.0.0.1:8114';

  const testnetConfigPath = path.join(root, 'testnet-config.yml');
  fs.writeFileSync(
    testnetConfigPath,
    [
      'fiber:',
      '  listening_addr: "/ip4/0.0.0.0/tcp/8228"',
      '  bootnode_addrs:',
      '    - "/ip4/54.179.226.154/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy"',
      '  chain: testnet',
      '  tlc_expiry_delta: 86400000',
      '  future_field_from_new_fnn: keep-me',
      'rpc:',
      '  listening_addr: "127.0.0.1:8227"',
      'ckb:',
      '  rpc_url: "https://testnet.ckbapp.dev/"',
      '  udt_whitelist:',
      '    - name: RUSD',
      '      script:',
      '        code_hash: 0x1142',
      '        hash_type: type',
      '        args: 0x878f',
      'services:',
      '  - fiber',
      '  - rpc',
      '  - ckb',
      '  - cch',
      '',
    ].join('\n'),
  );
  return { settings, testnetConfigPath };
}

function chainScripts(): FiberChainScripts {
  const dep = (index: number) => ({
    cell_dep: { out_point: { tx_hash: '0xgenesis', index: `0x${index.toString(16)}` }, dep_type: 'code' as const },
  });
  return {
    genesisHash: '0xgenesis',
    fiberScripts: [
      {
        name: 'FundingLock',
        script: { code_hash: '0xfunding', hash_type: 'data2', args: '0x' },
        cell_deps: [dep(21), dep(20)],
      },
      {
        name: 'CommitmentLock',
        script: { code_hash: '0xcommitment', hash_type: 'data2', args: '0x' },
        cell_deps: [dep(22), dep(20)],
      },
    ],
    udtWhitelist: [
      {
        name: 'sudt',
        script: { code_hash: '0xsudt', hash_type: 'type', args: '^0xissuer$' },
        cell_deps: [dep(5)],
      },
    ],
  };
}

describe('generateNodeConfig', () => {
  it('replaces chain-related fields and keeps unknown ones', () => {
    const { settings, testnetConfigPath } = fixture();
    const configFile = generateNodeConfig({
      node: { id: 2, config: {} },
      chainScripts: chainScripts(),
      testnetConfigPath,
      settings,
    });
    expect(configFile).toBe(fiberNodePaths(2, settings).configFile);

    const config = yaml.load(fs.readFileSync(configFile, 'utf8')) as Record<string, any>;
    expect(config.fiber.chain).toBe('../../../specs/dev.toml');
    expect(config.fiber.listening_addr).toBe('/ip4/127.0.0.1/tcp/8345');
    expect(config.fiber.bootnode_addrs).toEqual([]);
    expect(config.fiber.announce_listening_addr).toBe(true);
    expect(config.fiber.announce_private_addr).toBe(true);
    expect(config.fiber.gossip_network_maintenance_interval_ms).toBe(1000);
    expect(config.fiber.gossip_store_maintenance_interval_ms).toBe(1000);
    expect(config.fiber.announced_node_name).toBe('offckb-fnn-2');
    expect(config.fiber.scripts).toHaveLength(2);
    expect(config.fiber.scripts[0].name).toBe('FundingLock');
    expect(config.fiber.scripts[0].cell_deps[1].cell_dep.out_point.index).toBe('0x14');
    // unknown fields survive
    expect(config.fiber.tlc_expiry_delta).toBe(86400000);
    expect(config.fiber.future_field_from_new_fnn).toBe('keep-me');

    expect(config.rpc.listening_addr).toBe('127.0.0.1:21715');
    expect(config.rpc.enabled_modules).toEqual(['channel', 'payment', 'graph', 'info', 'invoice', 'peer', 'watchtower']);
    expect(config.rpc.cors_enabled).toBe(false);

    expect(config.ckb.rpc_url).toBe('http://127.0.0.1:8114');
    expect(config.ckb.udt_whitelist).toHaveLength(1);
    expect(config.ckb.udt_whitelist[0].script.args).toBe('^0xissuer$');

    expect(config.services).toEqual(['fiber', 'rpc', 'ckb']);
  });

  it('merges per-node config recursively and replaces lists', () => {
    const { settings, testnetConfigPath } = fixture();
    const configFile = generateNodeConfig({
      node: {
        id: 1,
        config: {
          fiber: { auto_accept_channel_ckb_funding_amount: 99, announced_node_name: 'custom-name' },
          rpc: { enabled_modules: ['info'] },
        },
      },
      chainScripts: chainScripts(),
      testnetConfigPath,
      settings,
    });
    const config = yaml.load(fs.readFileSync(configFile, 'utf8')) as Record<string, any>;
    expect(config.fiber.auto_accept_channel_ckb_funding_amount).toBe(99);
    expect(config.fiber.announced_node_name).toBe('custom-name');
    // managed values merged around the override stay
    expect(config.fiber.chain).toBe('../../../specs/dev.toml');
    // lists replace
    expect(config.rpc.enabled_modules).toEqual(['info']);
  });
});

describe('mergeNodeConfig', () => {
  it('merges objects deeply and replaces scalars and arrays', () => {
    const merged = mergeNodeConfig(
      { a: { b: 1, c: [1, 2], d: { e: 1 } }, x: 1 },
      { a: { c: [3], d: { f: 2 } }, y: 2 },
    );
    expect(merged).toEqual({ a: { b: 1, c: [3], d: { e: 1, f: 2 } }, x: 1, y: 2 });
  });
});
