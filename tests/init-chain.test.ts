import fs from 'fs';
import os from 'os';
import path from 'path';

let mockConfigPath = '';

jest.mock('../src/cfg/setting', () => ({
  packageRootPath: path.resolve(__dirname, '..'),
  readSettings: () => ({
    devnet: { configPath: mockConfigPath, rpcUrl: 'http://127.0.0.1:8114' },
  }),
}));

jest.mock('../src/util/logger', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));

import { initChainIfNeeded } from '../src/node/init-chain';

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
