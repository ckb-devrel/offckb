import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/util/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    result: jest.fn(),
  },
}));

// `which offckb` is routed to a temp bin dir: mutating PATH does not reach
// child processes under the jest VM environment.
const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  addTrustedSource,
  commitNativeRegistration,
  getNativeBinaryPath,
  listNativeTools,
  listPlugins,
  listTrustedSources,
  nativeToolEnv,
  normalizeTrustedSource,
  pluginNativeDir,
  removePlugin,
  removeTrustedSource,
} from '../src/plugins/store';
import { linkPlugin } from '../src/plugins/store';
import { ensureCommandShim } from '../src/plugins/shims';

let home: string;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-native-store-test-'));
  home = path.join(root, 'plugin-home');
  process.env.OFFCKB_PLUGIN_HOME = home;
});

afterEach(() => {
  delete process.env.OFFCKB_PLUGIN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('trusted-source allowlist', () => {
  it('normalizes and validates source identities', () => {
    expect(normalizeTrustedSource('SomeOwner/SomeRepo')).toBe('someowner/somerepo');
    expect(normalizeTrustedSource('@MyScope/pkg')).toBe('@myscope/pkg');
    expect(() => normalizeTrustedSource('../evil')).toThrow('Invalid trusted source');
    expect(() => normalizeTrustedSource('a repo')).toThrow('Invalid trusted source');
    expect(() => normalizeTrustedSource('')).toThrow('Invalid trusted source');
  });

  it('adds, lists and removes approvals idempotently', () => {
    expect(listTrustedSources()).toEqual([]);
    addTrustedSource('owner/repo');
    addTrustedSource('owner/repo');
    addTrustedSource('@scope/pkg');
    expect(listTrustedSources()).toEqual(['owner/repo', '@scope/pkg']);
    removeTrustedSource('owner/repo');
    expect(listTrustedSources()).toEqual(['@scope/pkg']);
    // Removing an unknown source is a no-op.
    removeTrustedSource('unknown/tool');
    expect(listTrustedSources()).toEqual(['@scope/pkg']);
  });
});

describe('native tool registrations', () => {
  const command = 'my-tool';

  function commitTool(version = 'v0.1.0'): void {
    const dir = pluginNativeDir(command);
    const binName = process.platform === 'win32' ? 'my-tool.exe' : 'my-tool';
    commitNativeRegistration(
      command,
      {
        binName,
        version,
        path: path.join(dir, binName),
        source: { kind: 'catalog', requested: 'my-tool', resolved: `my-tool@${version}` },
      },
      new Set(),
      () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, binName), '#!/bin/sh\necho my-tool\n');
        fs.writeFileSync(
          path.join(dir, 'offckb-plugin.json'),
          JSON.stringify({
            apiVersion: 1,
            kind: 'binary',
            name: 'my-tool',
            version,
            command,
            binary: { name: 'my-tool' },
            release: { repo: 'owner/repo', asset: 'my-tool_{tag}_{target}.tar.gz', checksum: '{asset}-sha256.txt' },
          }),
        );
      },
    );
  }

  it('registers a binary tool and exposes its stable path and env entry', () => {
    commitTool();

    const [info] = listPlugins(new Set());
    expect(info).toMatchObject({
      command,
      kind: 'binary',
      mode: 'trusted',
      state: 'available',
      name: 'my-tool',
      version: 'v0.1.0',
      source: { kind: 'catalog', requested: 'my-tool', resolved: 'my-tool@v0.1.0' },
    });
    const binaryPath = path.join(pluginNativeDir(command), process.platform === 'win32' ? 'my-tool.exe' : 'my-tool');
    expect(getNativeBinaryPath(command)).toBe(binaryPath);
    expect(nativeToolEnv()).toEqual({ OFFCKB_TOOL_MY_TOOL: binaryPath });
    expect(listNativeTools()).toEqual([{ command, envName: 'OFFCKB_TOOL_MY_TOOL', path: binaryPath }]);
  });

  it('rejects conflicts with core commands and JS plugin registrations', () => {
    expect(() =>
      commitNativeRegistration(
        'install',
        {
          binName: 'install',
          version: 'v0.1.0',
          path: path.join(pluginNativeDir('install'), 'install'),
          source: { kind: 'catalog', requested: 'install', resolved: 'install@v0.1.0' },
        },
        new Set(['install']),
        () => undefined,
      ),
    ).toThrow('core command');

    // A JS plugin already holding the command blocks a native takeover.
    const jsRoot = path.join(root, 'js-plugin');
    fs.mkdirSync(jsRoot);
    fs.writeFileSync(path.join(jsRoot, 'entry.mjs'), '');
    fs.writeFileSync(
      path.join(jsRoot, 'package.json'),
      JSON.stringify({ name: 'js-tool', version: '1.0.0', offckb: { apiVersion: 1, command, entry: 'entry.mjs' } }),
    );
    linkPlugin(jsRoot, new Set());
    expect(() => commitTool()).toThrow('already linked');
  });

  it('rejects a registry whose binary entry carries JS-only grants', () => {
    fs.mkdirSync(home, { recursive: true });
    const dir = pluginNativeDir(command);
    fs.writeFileSync(
      path.join(home, 'registry.json'),
      JSON.stringify({
        apiVersion: 2,
        plugins: {
          [command]: {
            directory: dir,
            permissions: ['devnet-read'],
            readPaths: [],
            binary: {
              binName: 'my-tool',
              version: 'v0.1.0',
              path: path.join(dir, 'my-tool'),
              source: { kind: 'catalog', requested: 'my-tool', resolved: 'my-tool@v0.1.0' },
            },
          },
        },
      }),
    );

    expect(() => listPlugins(new Set())).toThrow('Invalid plugin registry');
  });

  it('remove deletes the managed directory and only offckb-owned shims', () => {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    const isWindows = process.platform === 'win32';
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      commitTool();
      // Shims are published by the install pipeline, not by the store commit;
      // create them as the installer would, then verify removal keeps only
      // what offckb owns.
      ensureCommandShim(command, getNativeBinaryPath(command)!);
      const binaryPath = getNativeBinaryPath(command)!;
      expect(fs.existsSync(binaryPath)).toBe(true);
      const shimPath = path.join(binDir, isWindows ? 'my-tool.cmd' : 'my-tool');
      const exePath = path.join(binDir, 'my-tool.exe');
      expect(fs.existsSync(shimPath)).toBe(true);
      // A foreign file next to the owned shim must survive removal.
      const foreignPath = path.join(binDir, isWindows ? 'my-tool.ps1' : 'my-tool-foreign');
      fs.writeFileSync(foreignPath, 'foreign');

      removePlugin(command);

      expect(fs.existsSync(binaryPath)).toBe(false);
      expect(fs.existsSync(pluginNativeDir(command))).toBe(false);
      expect(fs.existsSync(shimPath)).toBe(false);
      if (isWindows) expect(fs.existsSync(exePath)).toBe(false);
      expect(fs.existsSync(foreignPath)).toBe(true);
      expect(getNativeBinaryPath(command)).toBeNull();
    } finally {
      mockSpawnSync.mockReset();
    }
  });
});
