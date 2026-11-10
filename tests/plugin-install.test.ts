import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import childProcess, { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { parsePluginInstallSpec, installPlugin, resolveNpmCli } from '../src/plugins/install';
import {
  acquirePlugin,
  commitPluginInstallation,
  linkPlugin,
  listPlugins,
  pluginPackagesPath,
  pluginStoragePaths,
  removePlugin,
  unlinkPlugin,
} from '../src/plugins/store';

let directory: string;
let previousHome: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb managed plugins '));
  previousHome = process.env.OFFCKB_PLUGIN_HOME;
  process.env.OFFCKB_PLUGIN_HOME = path.join(directory, 'home');
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
  else process.env.OFFCKB_PLUGIN_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each([
  ['tool', 'tool@latest'],
  ['npm:@scope/tool@1.2.3', '@scope/tool@1.2.3'],
  ['@scope/tool@next', '@scope/tool@next'],
  ['tool@^1.2.0', 'tool@^1.2.0'],
  ['github:owner/repo#v1', 'git+https://github.com/owner/repo.git#v1'],
  ['https://github.com/owner/repo.git#main', 'git+https://github.com/owner/repo.git#main'],
  ['owner/repo', 'git+https://github.com/owner/repo.git'],
])('normalizes source %s without accepting a shell command', (source, spec) => {
  expect(parsePluginInstallSpec(source).spec).toBe(spec);
});

it.each([
  '--prefix=/tmp',
  'file:../package',
  './package',
  '../package',
  'git+ssh://git@github.com/o/r',
  'https://evil.test/package.tgz',
  'https://github.com/o/r?token=secret',
  'tool@file:../package',
  'tool@npm:other',
  'tool\n--global',
  'github:owner/repo#ref;echo',
  '',
])('rejects unsupported or ambiguous source %j', (source) => {
  expect(() => parsePluginInstallSpec(source)).toThrow();
});

it('finds a JavaScript npm CLI rather than attempting npm.cmd as a native executable', () => {
  expect(path.basename(resolveNpmCli())).toBe('npm-cli.js');
});

it('requires independent script consent before any package-manager work', async () => {
  await expect(installPlugin('tool', new Set(), { allowScripts: true })).rejects.toThrow(
    '--allow-scripts requires --trust',
  );
  expect(fs.existsSync(process.env.OFFCKB_PLUGIN_HOME!)).toBe(false);
});

function managed(version = '1.0.0', permissions: string[] = [], name = 'test-probe') {
  const id = randomUUID();
  const root = path.join(pluginPackagesPath(), id);
  const packageDirectory = path.join(root, 'node_modules', name);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name, version, offckb: { apiVersion: 1, command: 'probe', entry: 'cli.cjs', permissions } }),
  );
  fs.writeFileSync(path.join(packageDirectory, 'cli.cjs'), 'throw new Error("must not execute during registration");');
  const installation = {
    id,
    name,
    allowScripts: false,
    source: { kind: 'npm' as const, requested: name, resolved: `${name}@${version}` },
  };
  return { root, directory: packageDirectory, installation };
}

it('replaces a managed package only after validation and while stopped, preserving data/cache', () => {
  const first = managed();
  commitPluginInstallation(first.directory, first.installation, new Set(), { trust: true });
  const data = path.join(pluginStoragePaths(first.installation.name).data, 'saved');
  fs.mkdirSync(path.dirname(data), { recursive: true });
  fs.writeFileSync(data, 'keep');
  const lease = acquirePlugin('probe');
  const second = managed('1.1.0', ['devnet-read']);
  expect(() => commitPluginInstallation(second.directory, second.installation, new Set(), { trust: true })).toThrow(
    'explicit grants',
  );
  expect(() =>
    commitPluginInstallation(second.directory, second.installation, new Set(), { trust: true, allow: ['devnet-read'] }),
  ).toThrow('running');
  expect(listPlugins(new Set())[0]).toMatchObject({ version: '1.0.0', source: first.installation.source });
  expect(fs.existsSync(first.root)).toBe(true);
  lease.release();
  commitPluginInstallation(second.directory, second.installation, new Set(), { trust: true, allow: ['devnet-read'] });
  expect(fs.existsSync(first.root)).toBe(false);
  expect(listPlugins(new Set())[0]).toMatchObject({
    version: '1.1.0',
    mode: 'trusted',
    source: second.installation.source,
  });
  expect(fs.readFileSync(data, 'utf8')).toBe('keep');
  expect(() => unlinkPlugin('probe')).toThrow('plugin remove');
  // Regranting runtime permissions must not lose managed ownership/provenance.
  linkPlugin(second.directory, new Set(), { allow: ['devnet-read'] });
  expect(listPlugins(new Set())[0].source).toEqual(second.installation.source);
  removePlugin('probe');
  expect(fs.existsSync(second.root)).toBe(false);
  expect(fs.readFileSync(data, 'utf8')).toBe('keep');
});

function mockNpmPackage() {
  return jest.spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options) => {
    const root = String(options?.cwd);
    const packageDirectory = path.join(root, 'node_modules/test-probe');
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'test-probe': '1.1.0' } }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    fs.writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'test-probe',
        version: '1.1.0',
        offckb: { apiVersion: 1, command: 'probe', entry: 'cli.cjs' },
      }),
    );
    fs.writeFileSync(path.join(packageDirectory, 'cli.cjs'), '');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    process.nextTick(() => child.emit('close', 0));
    return child as ChildProcess;
  });
}

it.each(['close', 'unlink', 'temporary', 'old-package'])(
  'never deletes the newly registered installation after a post-commit %s cleanup failure',
  async (failure) => {
    const previous = managed();
    commitPluginInstallation(previous.directory, previous.installation, new Set(), { trust: true });
    mockNpmPackage();
    const lock = path.join(process.env.OFFCKB_PLUGIN_HOME!, 'registry.lock');
    const open = fs.openSync;
    let lockFd: number | undefined;
    jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (String(file) === lock) lockFd = fd;
      return fd;
    });
    const close = fs.closeSync;
    jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      close(fd);
      if (failure === 'close' && fd === lockFd) throw new Error('injected close failure');
    });
    const unlink = fs.unlinkSync;
    jest.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (failure === 'unlink' && String(file) === lock) throw new Error('injected unlink failure');
      unlink(file);
    });
    const rm = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (
        (failure === 'temporary' && String(file).endsWith('.tmp')) ||
        (failure === 'old-package' && String(file) === previous.root)
      )
        throw new Error('injected cleanup failure');
      rm(file, options);
    });
    const result = await installPlugin('test-probe@1.1.0', new Set(), { trust: true });
    expect(fs.existsSync(result.plugin.entry)).toBe(true);
    expect(listPlugins(new Set())[0]).toMatchObject({
      state: 'available',
      directory: result.plugin.directory,
      version: '1.1.0',
    });
    expect(fs.existsSync(previous.root)).toBe(failure === 'old-package');
  },
);

it('removes only the uncommitted candidate when the registry rename fails', async () => {
  const previous = managed();
  commitPluginInstallation(previous.directory, previous.installation, new Set(), { trust: true });
  mockNpmPackage();
  jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('injected registry rename failure');
  });
  await expect(installPlugin('test-probe@1.1.0', new Set(), { trust: true })).rejects.toThrow(
    'registry rename failure',
  );
  expect(listPlugins(new Set())[0]).toMatchObject({ version: '1.0.0', directory: previous.directory });
  expect(fs.readdirSync(pluginPackagesPath())).toEqual([previous.installation.id]);
});

it('transfers installation ownership immediately after the atomic registry switch', () => {
  const previous = managed();
  commitPluginInstallation(previous.directory, previous.installation, new Set(), {});
  const candidate = managed('1.1.0');
  const committed = jest.fn(() => {
    expect(listPlugins(new Set())[0].directory).toBe(candidate.directory);
    expect(fs.existsSync(previous.root)).toBe(true);
    expect(fs.existsSync(path.join(process.env.OFFCKB_PLUGIN_HOME!, 'registry.lock'))).toBe(true);
  });
  commitPluginInstallation(candidate.directory, candidate.installation, new Set(), {}, committed);
  expect(committed).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(previous.root)).toBe(false);
});

it('does not replace/delete an external link or a different package that uses the same command', () => {
  const linked = managed();
  linkPlugin(linked.directory, new Set());
  const impostor = managed('1.0.0', [], 'impostor');
  expect(() => commitPluginInstallation(impostor.directory, impostor.installation, new Set(), {})).toThrow(
    'already linked',
  );
  removePlugin('probe');
  expect(fs.existsSync(linked.directory)).toBe(true);
  commitPluginInstallation(linked.directory, linked.installation, new Set(), {});
  expect(() => commitPluginInstallation(impostor.directory, impostor.installation, new Set(), {})).toThrow(
    'already linked',
  );
});

it('can remove an installation whose package files are missing without following a replaced root link', () => {
  const installed = managed();
  commitPluginInstallation(installed.directory, installed.installation, new Set(), {});
  fs.rmSync(installed.directory, { recursive: true });
  expect(listPlugins(new Set())[0].state).toBe('invalid');
  removePlugin('probe');
  expect(fs.existsSync(installed.root)).toBe(false);
  const next = managed();
  commitPluginInstallation(next.directory, next.installation, new Set(), {});
  fs.rmSync(next.root, { recursive: true });
  fs.symlinkSync(directory, next.root, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => removePlugin('probe')).toThrow('symlink');
  expect(fs.existsSync(directory)).toBe(true);
  fs.unlinkSync(next.root);
});
