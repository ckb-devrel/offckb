import fs from 'fs';
import os from 'os';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';

let mockConfigPath = '';

jest.mock('../src/cfg/setting', () => ({
  packageRootPath: path.resolve(__dirname, '..'),
  readSettings: () => ({
    devnet: { configPath: mockConfigPath, rpcUrl: 'http://127.0.0.1:8114' },
  }),
}));

jest.mock('../src/util/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { initChainIfNeeded, migrateLegacyDevnetRpcConfig } from '../src/node/init-chain';

const LEGACY_CKB_TOML = `# legacy devnet config from before the ckb-tui fix
# a custom comment that must survive migration

[rpc]
listen_address = "127.0.0.1:8114"

# List of API modules: ["Net", "Pool", "Miner", "Chain", "Stats", "Subscription", "Experiment", "Debug", "Indexer"]
modules = ["Net", "Pool", "Miner", "Chain", "Stats", "Subscription", "Experiment", "Debug", "Indexer"]

# By default RPC only binds to HTTP service, you can bind it to TCP and WebSocket.
# tcp_listen_address = "127.0.0.1:18114"
# ws_listen_address = "127.0.0.1:28114"
reject_ill_transactions = true

[miner]
# keep this section untouched
`;

function readCkbToml(configPath: string): JsonMap {
  return toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8'));
}

describe('initChainIfNeeded', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-init-chain-'));
    mockConfigPath = path.join(root, 'devnet');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('repairs a fresh daemon directory that contains only data/logs', async () => {
    fs.mkdirSync(path.join(mockConfigPath, 'data', 'logs'), { recursive: true });

    await initChainIfNeeded();

    expect(fs.existsSync(path.join(mockConfigPath, 'ckb.toml'))).toBe(true);
    expect(fs.existsSync(path.join(mockConfigPath, 'ckb-miner.toml'))).toBe(true);
    expect(fs.existsSync(path.join(mockConfigPath, 'specs', 'dev.toml'))).toBe(true);
    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb-miner.toml'), 'utf8')).toContain('http://127.0.0.1:8114');
  });

  it('does not overwrite a complete custom config', async () => {
    fs.mkdirSync(path.join(mockConfigPath, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), 'custom-ckb');
    fs.writeFileSync(path.join(mockConfigPath, 'ckb-miner.toml'), 'custom-miner');
    fs.writeFileSync(path.join(mockConfigPath, 'specs', 'dev.toml'), 'custom-spec');

    await initChainIfNeeded();

    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8')).toBe('custom-ckb');
    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb-miner.toml'), 'utf8')).toBe('custom-miner');
  });

  it('repairs missing files without overwriting partial custom configuration', async () => {
    fs.mkdirSync(mockConfigPath, { recursive: true });
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), 'custom-ckb');

    await initChainIfNeeded();

    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8')).toBe('custom-ckb');
    expect(fs.existsSync(path.join(mockConfigPath, 'ckb-miner.toml'))).toBe(true);
    expect(fs.existsSync(path.join(mockConfigPath, 'specs', 'dev.toml'))).toBe(true);
  });
});

describe('migrateLegacyDevnetRpcConfig', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-migrate-rpc-'));
    mockConfigPath = path.join(root, 'devnet');
    fs.mkdirSync(mockConfigPath, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('enables the Terminal module and TCP stream on a legacy config, preserving comments', () => {
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), LEGACY_CKB_TOML);

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(true);

    const text = fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8');
    expect(text).toContain('# a custom comment that must survive migration');
    expect(text).not.toContain('# tcp_listen_address');
    const parsed = readCkbToml(mockConfigPath);
    const rpc = parsed.rpc as JsonMap;
    expect(rpc.modules).toContain('Terminal');
    expect(rpc.modules).toContain('Indexer');
    expect(rpc.tcp_listen_address).toBe('127.0.0.1:18114');
    expect(rpc.reject_ill_transactions).toBe(true);
  });

  it('runs through initChainIfNeeded so existing installs pick it up on node start', async () => {
    fs.mkdirSync(path.join(mockConfigPath, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), LEGACY_CKB_TOML);
    fs.writeFileSync(path.join(mockConfigPath, 'ckb-miner.toml'), 'custom-miner');
    fs.writeFileSync(path.join(mockConfigPath, 'specs', 'dev.toml'), 'custom-spec');

    await initChainIfNeeded();

    const rpc = readCkbToml(mockConfigPath).rpc as JsonMap;
    expect(rpc.modules).toContain('Terminal');
    expect(rpc.tcp_listen_address).toBe('127.0.0.1:18114');
    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb-miner.toml'), 'utf8')).toBe('custom-miner');
  });

  it('is a no-op on the current bundled template', async () => {
    await initChainIfNeeded();
    const before = fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8');

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(false);
    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8')).toBe(before);
  });

  it('appends Terminal without dropping a custom module subset', () => {
    const custom = LEGACY_CKB_TOML.replace(
      'modules = ["Net", "Pool", "Miner", "Chain", "Stats", "Subscription", "Experiment", "Debug", "Indexer"]',
      'modules = ["Net", "Chain"]',
    );
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), custom);

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(true);

    const rpc = readCkbToml(mockConfigPath).rpc as JsonMap;
    expect(rpc.modules).toEqual(['Net', 'Chain', 'Terminal']);
  });

  it('handles a hand-formatted multi-line modules array', () => {
    const multiline = LEGACY_CKB_TOML.replace(
      'modules = ["Net", "Pool", "Miner", "Chain", "Stats", "Subscription", "Experiment", "Debug", "Indexer"]',
      'modules = [\n  "Net",\n  "Indexer"\n]',
    );
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), multiline);

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(true);

    const rpc = readCkbToml(mockConfigPath).rpc as JsonMap;
    expect(rpc.modules).toEqual(['Net', 'Indexer', 'Terminal']);
  });

  it('inserts tcp_listen_address when no commented line exists', () => {
    const noTcpStub = LEGACY_CKB_TOML.replace('# tcp_listen_address = "127.0.0.1:18114"\n', '');
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), noTcpStub);

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(true);

    const rpc = readCkbToml(mockConfigPath).rpc as JsonMap;
    expect(rpc.tcp_listen_address).toBe('127.0.0.1:18114');
  });

  it('keeps an explicitly configured tcp_listen_address', () => {
    const custom = LEGACY_CKB_TOML.replace(
      '# tcp_listen_address = "127.0.0.1:18114"',
      'tcp_listen_address = "127.0.0.1:29114"',
    );
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), custom);

    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(true);

    const rpc = readCkbToml(mockConfigPath).rpc as JsonMap;
    expect(rpc.tcp_listen_address).toBe('127.0.0.1:29114');
    expect(rpc.modules).toContain('Terminal');
  });

  it('ignores unparseable or section-less configs without throwing', () => {
    fs.writeFileSync(path.join(mockConfigPath, 'ckb.toml'), 'custom-ckb');
    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(false);
    expect(fs.readFileSync(path.join(mockConfigPath, 'ckb.toml'), 'utf8')).toBe('custom-ckb');
  });

  it('returns false when ckb.toml does not exist', () => {
    expect(migrateLegacyDevnetRpcConfig(mockConfigPath)).toBe(false);
  });
});
