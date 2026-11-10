import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { nodesYmlPath, fiberNodePaths } from '../src/fiber/paths';
import {
  newNodeEntry,
  readFiberManifest,
  validateNodeCount,
  writeManifest,
  resolveNodeFile,
} from '../src/fiber/nodes-yml';
import { initializeFiberEnvironment, pendingInitFile } from '../src/fiber/init';
import * as install from '../src/fiber/install';
import { FiberChainScripts } from '../src/fiber/scripts';
import { biscuitPaths } from '../src/fiber/auth';
import childProcess from 'child_process';
import { startFiberEnvironment } from '../src/fiber/manager';
import { customConfig } from '../src/fiber/config-gen';

const roots: string[] = [];
const chain: FiberChainScripts = { genesisHash: '0xgenesis', fiberScripts: [], udtWhitelist: [] };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-init-'));
  roots.push(root);
  const settings = structuredClone(defaultSettings) as Settings;
  settings.devnet.configPath = path.join(root, 'devnet');
  settings.devnet.dataPath = path.join(root, 'devnet/data');
  const template = path.join(root, 'template.yml');
  fs.writeFileSync(template, 'fiber: {}\nrpc: {}\nckb: {}\n');
  jest.spyOn(install, 'resolveFnnBinary').mockResolvedValue({
    fnnPath: process.execPath,
    testnetConfigPath: template,
    source: 'binary-path',
    version: '0.9.0',
  });
  return settings;
}
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

it('validates node counts', () => {
  expect(validateNodeCount(1)).toBe(1);
  expect(validateNodeCount(16)).toBe(16);
  for (const count of [0, 17, 1.5, NaN]) expect(() => validateNodeCount(count)).toThrow();
});
it('prepares two nodes by default, with private independent keys and no FNN store', async () => {
  const settings = fixture();
  const manifest = await initializeFiberEnvironment({}, chain, settings);
  expect(manifest.nodes.map((node) => node.id)).toEqual([1, 2]);
  expect(manifest.nodes.map((node) => node.account)).toEqual([
    { type: 'builtin', index: 3 },
    { type: 'builtin', index: 4 },
  ]);
  const tokens = manifest.nodes.map((node) => fs.readFileSync(resolveNodeFile(node.rpc_token_file, settings), 'utf8'));
  expect(tokens[0]).not.toBe(tokens[1]);
  expect(fs.existsSync(fiberNodePaths(1, settings).fiberStoreDir)).toBe(false);
  expect(customConfig(manifest.nodes[0], settings)).toBe('no');
  expect(fs.existsSync(pendingInitFile(settings))).toBe(false);
  if (process.platform !== 'win32') expect(fs.statSync(nodesYmlPath(settings)).mode & 0o777).toBe(0o600);
});
it('keeps configs, keys and tokens byte-for-byte on repeated init and startup preparation', async () => {
  const settings = fixture();
  const first = await initializeFiberEnvironment({ nodes: 3 }, chain, settings);
  const configFile = resolveNodeFile(first.nodes[2].config_file, settings);
  const config = yaml.load(fs.readFileSync(configFile, 'utf8')) as any;
  config.services.push('lsp');
  config.lsp = { enabled: true };
  config.rpc.enabled_modules.push('lsp');
  fs.writeFileSync(configFile, yaml.dump(config));
  const files = [
    nodesYmlPath(settings),
    configFile,
    fiberNodePaths(3, settings).ckbKeyFile,
    fiberNodePaths(3, settings).passwordFile,
    biscuitPaths(3, settings).privateKey,
    resolveNodeFile(first.nodes[2].rpc_token_file, settings),
  ];
  const before = files.map((file) => fs.readFileSync(file));
  await initializeFiberEnvironment({}, chain, settings, true);
  await initializeFiberEnvironment({ nodes: 3 }, chain, settings);
  expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
  expect(customConfig(first.nodes[2], settings)).toBe('yes');
  expect(install.resolveFnnBinary).toHaveBeenCalledTimes(1);
});
it('appends explicit and random accounts without reassigning existing nodes', async () => {
  const settings = fixture();
  await initializeFiberEnvironment({}, chain, settings);
  const third = await initializeFiberEnvironment({ add: true, accountIndex: 12 }, chain, settings);
  expect(third.nodes[2].account).toEqual({ type: 'builtin', index: 12 });
  const fourth = await initializeFiberEnvironment({ add: true, randomAccount: true }, chain, settings);
  expect(fourth.nodes[3].account).toEqual({ type: 'random', key: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  expect((await initializeFiberEnvironment({}, chain, settings)).nodes[3].account).toEqual(fourth.nodes[3].account);
});
it('supports seeded new accounts and resolves paths from nodes.yml', async () => {
  const settings = fixture();
  const node = newNodeEntry(1, { type: 'random' });
  node.config_file = 'custom/one.yml';
  writeManifest({ nodes: [node] }, settings);
  const manifest = await initializeFiberEnvironment({}, chain, settings);
  expect(manifest.nodes[0].account).toHaveProperty('key');
  expect(resolveNodeFile(node.config_file, settings)).toBe(
    path.join(settings.devnet.configPath, 'fiber/custom/one.yml'),
  );
});
it('rejects missing registered files without replacing any keys', async () => {
  const settings = fixture();
  const manifest = await initializeFiberEnvironment({}, chain, settings);
  const token = resolveNodeFile(manifest.nodes[0].rpc_token_file, settings);
  fs.unlinkSync(token);
  await expect(initializeFiberEnvironment({}, chain, settings)).rejects.toThrow(token);
  expect(fs.existsSync(token)).toBe(false);
});
it('refuses orphan directories and conflicting flags before writing', async () => {
  const settings = fixture();
  await expect(initializeFiberEnvironment({ add: true }, chain, settings)).rejects.toThrow('No Fiber environment');
  await expect(initializeFiberEnvironment({ nodes: 2, add: true }, chain, settings)).rejects.toThrow(
    'mutually exclusive',
  );
  await expect(initializeFiberEnvironment({ randomAccount: true }, chain, settings)).rejects.toThrow('require --add');
  fs.mkdirSync(fiberNodePaths(1, settings).dir, { recursive: true });
  await expect(initializeFiberEnvironment({}, chain, settings)).rejects.toThrow('without nodes.yml');
  expect(fs.existsSync(nodesYmlPath(settings))).toBe(false);
});
it('does not shrink or change node count/program while starting an existing environment', async () => {
  const settings = fixture();
  await initializeFiberEnvironment({ nodes: 3 }, chain, settings);
  await expect(initializeFiberEnvironment({ nodes: 2 }, chain, settings)).rejects.toThrow('cannot remove');
  await expect(initializeFiberEnvironment({ nodes: 4 }, chain, settings, true)).rejects.toThrow('conflicts');
  await expect(initializeFiberEnvironment({ version: '1.0.0' }, chain, settings)).rejects.toThrow('conflicts');
  expect(readFiberManifest(settings)!.nodes).toHaveLength(3);
});
it('skips reserved directories when appending and rejects id overflow without mutations', async () => {
  const settings = fixture();
  await initializeFiberEnvironment({}, chain, settings);
  fs.mkdirSync(fiberNodePaths(15, settings).dir, { recursive: true });
  const next = await initializeFiberEnvironment({ add: true }, chain, settings);
  expect(next.nodes.map((node) => node.id)).toEqual([1, 2, 16]);
  const before = fs.readFileSync(nodesYmlPath(settings));
  await expect(initializeFiberEnvironment({ add: true }, chain, settings)).rejects.toThrow('1 to 16');
  expect(fs.readFileSync(nodesYmlPath(settings))).toEqual(before);
});
it('resumes a failed provision with exactly the saved random key', async () => {
  const settings = fixture();
  await initializeFiberEnvironment({}, chain, settings);
  const tokenFile = resolveNodeFile(newNodeEntry(3).rpc_token_file, settings);
  const rename = fs.renameSync;
  const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === tokenFile) throw new Error('simulated disk full');
    return rename(from, to);
  });
  await expect(initializeFiberEnvironment({ add: true, randomAccount: true }, chain, settings)).rejects.toThrow(
    'disk full',
  );
  spy.mockRestore();
  const key = fs.readFileSync(fiberNodePaths(3, settings).ckbKeyFile);
  const recovered = await initializeFiberEnvironment({ add: true, randomAccount: true }, chain, settings);
  expect(recovered.nodes).toHaveLength(3);
  expect(fs.readFileSync(fiberNodePaths(3, settings).ckbKeyFile)).toEqual(key);
  expect(fs.existsSync(pendingInitFile(settings))).toBe(false);
});
it('rejects aliases between a token and a funding key before creating directories', async () => {
  const settings = fixture();
  const node = newNodeEntry(1);
  node.rpc_token_file = 'nodes/1/ckb/key';
  writeManifest({ nodes: [node] }, settings);
  await expect(initializeFiberEnvironment({}, chain, settings)).rejects.toThrow('collides');
  expect(fs.existsSync(fiberNodePaths(1, settings).ckbKeyFile)).toBe(false);
});
it('rejects legacy formats and never exposes private values in YAML diagnostics', () => {
  const settings = fixture();
  fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
  fs.writeFileSync(nodesYmlPath(settings), yaml.dump({ nodes: [{ id: 1, config: {} }] }));
  expect(() => readFiberManifest(settings)).toThrow('unsupported');
  fs.writeFileSync(nodesYmlPath(settings), 'nodes: [SECRET_PRIVATE_KEY');
  try {
    readFiberManifest(settings);
    throw new Error('expected error');
  } catch (error) {
    expect((error as Error).message).not.toContain('SECRET_PRIVATE_KEY');
  }
});

it('validates every node before spawning any process', async () => {
  const settings = fixture();
  const manifest = await initializeFiberEnvironment({}, chain, settings);
  const file = resolveNodeFile(manifest.nodes[1].config_file, settings);
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as any;
  config.rpc.enabled_modules = ['channel'];
  fs.writeFileSync(file, yaml.dump(config));
  const spawn = jest.spyOn(childProcess, 'spawn');
  await expect(startFiberEnvironment({ chainScripts: chain, settings })).rejects.toThrow('rpc.enabled_modules');
  expect(spawn).not.toHaveBeenCalled();
  config.rpc.enabled_modules = ['info', 'peer'];
  fs.writeFileSync(file, yaml.dump(config));
  const passwordFile = fiberNodePaths(2, settings).passwordFile;
  const password = fs.readFileSync(passwordFile);
  fs.writeFileSync(passwordFile, '');
  await expect(startFiberEnvironment({ chainScripts: chain, settings })).rejects.toThrow('password');
  fs.writeFileSync(passwordFile, password);
  fs.mkdirSync(fiberNodePaths(2, settings).fiberStoreDir, { recursive: true });
  await expect(startFiberEnvironment({ chainScripts: chain, settings })).rejects.toThrow(
    fiberNodePaths(2, settings).fiberSkFile,
  );
  expect(spawn).not.toHaveBeenCalled();
});
