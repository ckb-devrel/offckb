import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { readPluginManifest, assertPluginCompatible } from '../src/plugins/manifest';
import { acquirePlugin, linkPlugin, listPlugins, unlinkPlugin } from '../src/plugins/store';
import { createPluginContext } from '../src/plugins/context';
import { registerPluginManagement } from '../src/plugins/cli';

const mockRunPlugin = jest.fn().mockResolvedValue(undefined);
const mockResolveScripts = jest.fn();
const mockExecFileSync = jest.fn();
const mockSettings = {
  devnet: { configPath: '', rpcUrl: 'http://127.0.0.1:18114', rpcProxyPort: 38114 },
  bins: { defaultCKBVersion: 'test' },
};
let mockBinary = '';
jest.mock('../src/cfg/setting', () => ({
  dataPath: '/unused',
  readSettings: () => mockSettings,
  getCKBBinaryPath: () => mockBinary,
}));
jest.mock('../src/scripts/private', () => ({ resolveDevnetSystemScriptsFromListHashes: () => mockResolveScripts() }));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
jest.mock('../src/util/daemon', () => ({ resolveCliEntry: () => '/current/offckb.js' }));
jest.mock('../src/plugins/run', () => ({ runPlugin: (...args: unknown[]) => mockRunPlugin(...args) }));

let directory: string;
let previousHome: string | undefined;
function makePlugin(command = 'probe', overrides: Record<string, unknown> = {}) {
  const root = path.join(directory, `${command} package ${Math.random()}`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'entry.mjs'), 'throw new Error("manifest discovery must not execute this");');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: `test-${command}`,
      version: '1.0.0',
      ...overrides,
      offckb: { apiVersion: 1, command, entry: 'entry.mjs', ...((overrides.offckb || {}) as object) },
    }),
  );
  return root;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb plugin tests '));
  previousHome = process.env.OFFCKB_PLUGIN_HOME;
  process.env.OFFCKB_PLUGIN_HOME = path.join(directory, 'home');
  mockSettings.devnet.configPath = path.join(directory, 'chain');
  mockBinary = path.join(directory, 'ckb');
  mockResolveScripts.mockReset();
  mockExecFileSync.mockReset().mockReturnValue('test hashes');
  mockRunPlugin.mockClear();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
  else process.env.OFFCKB_PLUGIN_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

it('reads only static metadata and checks Node requirements before execution', () => {
  const root = makePlugin('probe', { engines: { node: '>=999' } });
  const plugin = readPluginManifest(root);
  expect(plugin.directory).toBe(fs.realpathSync(root));
  expect(() => assertPluginCompatible(plugin)).toThrow('requires Node');
});

it.each([{ apiVersion: 2 }, { command: '../escape' }, { entry: '../outside.mjs' }, { entry: '.' }])(
  'rejects invalid or escaping declarations: %j',
  (offckb) => {
    fs.writeFileSync(path.join(directory, 'outside.mjs'), '');
    expect(() => readPluginManifest(makePlugin('probe', { offckb }))).toThrow();
  },
);

it('rejects an entry symlink that resolves outside the package', () => {
  if (process.platform === 'win32') return; // Creating symlinks may require elevation.
  const root = makePlugin();
  fs.writeFileSync(path.join(directory, 'outside.mjs'), '');
  fs.unlinkSync(path.join(root, 'entry.mjs'));
  fs.symlinkSync(path.join(directory, 'outside.mjs'), path.join(root, 'entry.mjs'));
  expect(() => readPluginManifest(root)).toThrow('inside the plugin');
});

it('links explicit paths, prevents conflicts and reports future core shadowing', () => {
  const root = makePlugin();
  expect(() => linkPlugin(root, new Set(['probe']))).toThrow('core command');
  linkPlugin(root, new Set());
  expect(listPlugins(new Set())[0].state).toBe('available');
  expect(() => linkPlugin(makePlugin(), new Set())).toThrow('already linked');
  expect(listPlugins(new Set(['probe']))[0].state).toBe('shadowed');
  unlinkPlugin('probe');
  expect(fs.existsSync(root)).toBe(true);
  expect(listPlugins(new Set())).toEqual([]);
});

it('allows removal of a broken package and blocks unlink/relink during a foreground run', () => {
  const root = makePlugin();
  linkPlugin(root, new Set());
  const lease = acquirePlugin('probe');
  expect(() => unlinkPlugin('probe')).toThrow('running');
  expect(() => linkPlugin(root, new Set())).toThrow('running');
  expect(() => acquirePlugin('probe')).toThrow('running');
  lease.release();
  fs.rmSync(root, { recursive: true });
  expect(listPlugins(new Set())[0].state).toBe('invalid');
  unlinkPlugin('probe');
});

it('preserves a corrupt registry instead of overwriting it', () => {
  fs.mkdirSync(process.env.OFFCKB_PLUGIN_HOME!);
  const file = path.join(process.env.OFFCKB_PLUGIN_HOME!, 'registry.json');
  fs.writeFileSync(file, '{broken');
  expect(() => linkPlugin(makePlugin(), new Set())).toThrow('Cannot read plugin registry');
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});

it('exports current chain metadata without keys and removes per-run files', () => {
  fs.mkdirSync(mockSettings.devnet.configPath);
  fs.writeFileSync(path.join(mockSettings.devnet.configPath, 'ckb.toml'), '');
  fs.writeFileSync(mockBinary, '');
  mockResolveScripts.mockReturnValue({
    scripts: { example: { script: { codeHash: '0x1234' } } },
    forkedFrom: 'mainnet',
    genesisHash: '0xabc',
  });
  const run = createPluginContext(readPluginManifest(makePlugin()), true);
  const value = JSON.parse(fs.readFileSync(run.file, 'utf8'));
  expect(value).toMatchObject({
    apiVersion: 1,
    output: 'json',
    cwd: process.cwd(),
    cli: { entry: '/current/offckb.js' },
    devnet: {
      kind: 'fork-of-mainnet',
      addressPrefix: 'ckb',
      genesisHash: '0xabc',
      rpcUrl: mockSettings.devnet.rpcUrl,
    },
  });
  expect(JSON.parse(fs.readFileSync(value.devnet.systemScriptsFile, 'utf8')).devnet.example).toBeDefined();
  expect(value).not.toHaveProperty('settings');
  expect(value).not.toHaveProperty('accounts');
  expect(value.devnet).not.toHaveProperty('diagnostic');
  run.dispose();
  expect(fs.existsSync(run.file)).toBe(false);
  expect(fs.existsSync(value.devnet.systemScriptsFile)).toBe(false);
});

it('represents an uninitialized chain as unknown and does not run CKB', () => {
  const run = createPluginContext(readPluginManifest(makePlugin()), false);
  expect(JSON.parse(fs.readFileSync(run.file, 'utf8')).devnet).toMatchObject({
    kind: 'unknown',
    addressPrefix: null,
    systemScriptsFile: null,
  });
  expect(mockResolveScripts).not.toHaveBeenCalled();
  expect(mockExecFileSync).not.toHaveBeenCalled();
  run.dispose();
});

it.each(['timeout', 'nonzero exit', 'invalid output'])(
  'keeps the context usable with unknown chain identity after list-hashes %s',
  (failure) => {
    fs.mkdirSync(mockSettings.devnet.configPath);
    fs.writeFileSync(path.join(mockSettings.devnet.configPath, 'ckb.toml'), '');
    fs.writeFileSync(mockBinary, '');
    const fail = () => {
      throw Object.assign(new Error('private stderr: rpc://user:secret@host'), {
        code: failure === 'timeout' ? 'ETIMEDOUT' : undefined,
        status: failure === 'nonzero exit' ? 1 : null,
      });
    };
    if (failure === 'invalid output') mockResolveScripts.mockImplementationOnce(fail);
    else mockExecFileSync.mockImplementationOnce(fail);
    const run = createPluginContext(readPluginManifest(makePlugin()), false);
    const value = JSON.parse(fs.readFileSync(run.file, 'utf8'));
    expect(value.devnet).toMatchObject({
      rpcUrl: mockSettings.devnet.rpcUrl,
      kind: 'unknown',
      genesisHash: null,
      addressPrefix: null,
      systemScriptsFile: null,
      diagnostic: { code: 'LIST_HASHES_FAILED', message: expect.any(String) },
    });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(fs.readdirSync(path.dirname(run.file))).toEqual(['context.json']);
    run.dispose();
    expect(fs.existsSync(run.file)).toBe(false);
  },
);

it('lets Commander parse only the core prefix and keeps plugin arguments opaque', async () => {
  linkPlugin(makePlugin(), new Set());
  const program = new Command().enablePositionalOptions().option('--json');
  const plugins = registerPluginManagement(program);
  const invocation = plugins.prepare([
    'node',
    'offckb',
    '--json',
    'probe',
    '--',
    '--json',
    '--json',
    '--project',
    'a b',
    '--',
    'tail',
  ]);
  await program.parseAsync(invocation.argv);
  expect(invocation.delegated()).toBe(true);
  expect(mockRunPlugin).toHaveBeenCalledWith('probe', ['--json', '--json', '--project', 'a b', '--', 'tail'], true);
});

it('does not interpret a plugin --json as the core output format and delegates help', async () => {
  linkPlugin(makePlugin(), new Set());
  const program = new Command().enablePositionalOptions().option('--json');
  const plugins = registerPluginManagement(program);
  for (const args of [['--json'], ['--help']]) {
    const invocation = plugins.prepare(['node', 'offckb', 'probe', ...args]);
    await program.parseAsync(invocation.argv);
    expect(mockRunPlugin).toHaveBeenLastCalledWith('probe', args, false);
  }
});

it('keeps core commands usable with a corrupt registry', async () => {
  fs.mkdirSync(process.env.OFFCKB_PLUGIN_HOME!);
  fs.writeFileSync(path.join(process.env.OFFCKB_PLUGIN_HOME!, 'registry.json'), 'not json');
  const program = new Command();
  const action = jest.fn();
  program.command('node').action(action);
  const plugins = registerPluginManagement(program);
  await program.parseAsync(plugins.prepare(['node', 'offckb', 'node']).argv);
  expect(action).toHaveBeenCalled();
});
