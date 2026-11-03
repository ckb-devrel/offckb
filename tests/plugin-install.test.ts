import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { parsePluginInstallSpec, installPlugin, resolveNpmCli } from '../src/plugins/install';
import {
  acquirePlugin,
  commitPluginInstallation,
  linkPlugin,
  listPlugins,
  pluginPackagesPath,
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
  const data = path.join(process.env.OFFCKB_PLUGIN_HOME!, 'data/probe/saved');
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
