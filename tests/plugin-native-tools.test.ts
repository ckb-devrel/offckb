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
  acquirePlugin,
  assertNativeRootSafe,
  commitNativeRegistration,
  commitPluginInstallation,
  getNativeBinaryPath,
  isSourceTrusted,
  linkPlugin,
  listNativeTools,
  listPlugins,
  listTrustedSources,
  nativeToolEnv,
  normalizeTrustedSource,
  pluginNativeDir,
  removePlugin,
  removeTrustedSource,
  unlinkPlugin,
} from '../src/plugins/store';
import { ensureCommandShim, removeCommandShims, shimMarkerPath } from '../src/plugins/shims';

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

  it('supports the documented @scope/* approval shorthand and rejects bare wildcards', () => {
    addTrustedSource('@MyOrg/*');
    expect(listTrustedSources()).toEqual(['@myorg/*']);
    expect(isSourceTrusted('@myorg/pkg')).toBe(true);
    expect(isSourceTrusted('@myorg/other-tool')).toBe(true);
    expect(isSourceTrusted('@other/pkg')).toBe(false);
    expect(() => normalizeTrustedSource('*')).toThrow('Invalid trusted source');
    expect(() => normalizeTrustedSource('owner/*')).toThrow('Invalid trusted source');
  });

  it('reports an actionable error when the plugin home is occupied by a file', () => {
    const fileHome = path.join(root, 'file-home');
    fs.writeFileSync(fileHome, 'not a directory');
    const currentHome = process.env.OFFCKB_PLUGIN_HOME;
    process.env.OFFCKB_PLUGIN_HOME = fileHome;
    try {
      expect(() => addTrustedSource('owner/repo')).toThrow(/Cannot create the plugin home/);
    } finally {
      if (currentHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
      else process.env.OFFCKB_PLUGIN_HOME = currentHome;
    }
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

  function commitTool(
    version = 'v0.1.0',
    options: { reserved?: ReadonlySet<string>; command?: string; permissions?: string[] } = {},
  ): void {
    const toolCommand = options.command ?? command;
    const dir = pluginNativeDir(toolCommand);
    const binName = process.platform === 'win32' ? 'my-tool.exe' : 'my-tool';
    const staging = `${dir}.staging-test`;
    const backup = `${dir}.backup-test`;
    // Mirrors the production installer: never stage through a symlinked root.
    assertNativeRootSafe();
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, binName), `#!/bin/sh\necho my-tool ${version}\n`);
    if (process.platform !== 'win32') fs.chmodSync(path.join(staging, binName), 0o755);
    fs.writeFileSync(
      path.join(staging, 'offckb-tool.json'),
      JSON.stringify({
        apiVersion: 1,
        name: 'my-tool',
        version,
        command: toolCommand,
        description: 'Native my-tool',
        entry: binName,
        permissions: options.permissions ?? [],
      }),
    );
    let swapped = false;
    commitNativeRegistration(
      toolCommand,
      {
        binName,
        version,
        path: path.join(dir, binName),
        source: { kind: 'catalog', id: 'my-tool', requested: 'my-tool', resolved: `my-tool@${version}` },
      },
      (options.permissions ?? []) as never,
      options.reserved ?? new Set(),
      () => {
        if (fs.existsSync(dir)) fs.renameSync(dir, backup);
        try {
          fs.renameSync(staging, dir);
          swapped = true;
        } catch (error) {
          if (fs.existsSync(backup)) fs.renameSync(backup, dir);
          throw error;
        }
      },
      () => {
        if (!swapped) return;
        fs.rmSync(dir, { recursive: true, force: true });
        if (fs.existsSync(backup)) fs.renameSync(backup, dir);
      },
    );
  }

  it('registers a binary tool and exposes its stable path and env entry', () => {
    commitTool();

    const [info] = listPlugins(new Set());
    expect(info).toMatchObject({
      command,
      kind: 'binary',
      // Binary tools always run natively with the user's permissions.
      mode: 'trusted',
      state: 'available',
      name: 'my-tool',
      version: 'v0.1.0',
      source: { kind: 'catalog', id: 'my-tool', requested: 'my-tool', resolved: 'my-tool@v0.1.0' },
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
          source: { kind: 'catalog', id: 'install', requested: 'install', resolved: 'install@v0.1.0' },
        },
        [],
        new Set(['install']),
        () => undefined,
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

  it('allows capability grants on binary entries but rejects JS-only read paths', () => {
    fs.mkdirSync(home, { recursive: true });
    const dir = pluginNativeDir(command);
    const writeRegistry = (overrides: Record<string, unknown>) =>
      fs.writeFileSync(
        path.join(home, 'registry.json'),
        JSON.stringify({
          apiVersion: 2,
          plugins: {
            [command]: {
              directory: dir,
              permissions: [],
              readPaths: [],
              binary: {
                binName: 'my-tool',
                version: 'v0.1.0',
                path: path.join(dir, 'my-tool'),
                source: { kind: 'catalog', id: 'my-tool', requested: 'my-tool', resolved: 'my-tool@v0.1.0' },
              },
              ...overrides,
            },
          },
        }),
      );
    // Declared capability grants are part of the unified model.
    writeRegistry({ permissions: ['devnet-read'] });
    expect(() => listPlugins(new Set())).not.toThrow();
    // Unknown permissions and JS-only read paths are still rejected.
    writeRegistry({ permissions: ['unknown-grant'] });
    expect(() => listPlugins(new Set())).toThrow('Invalid plugin registry');
    writeRegistry({ permissions: [], readPaths: ['/etc'] });
    expect(() => listPlugins(new Set())).toThrow('Invalid plugin registry');
  });

  it('acquires binary tools as trusted and rejects tampered registration kinds', () => {
    commitTool();
    // Binary tools always run natively: no sandbox runtime is ever required.
    const lease = acquirePlugin(command);
    try {
      expect(lease.mode).toBe('trusted');
      expect(lease.plugin.kind).toBe('binary');
    } finally {
      lease.release();
    }

    // A JS-shaped registration whose directory later grows a binary
    // descriptor must not silently change how it executes.
    const jsRoot = path.join(root, 'js-tamper');
    fs.mkdirSync(jsRoot);
    fs.writeFileSync(path.join(jsRoot, 'entry.mjs'), '');
    fs.writeFileSync(
      path.join(jsRoot, 'package.json'),
      JSON.stringify({ name: 'js-tamper', version: '1.0.0', offckb: { apiVersion: 1, command: 'js-tamper', entry: 'entry.mjs' } }),
    );
    linkPlugin(jsRoot, new Set());
    // A valid binary descriptor appearing in a linked directory is honored
    // (the user owns the directory); it still runs sandboxed unless the link
    // was explicitly trusted, so nothing silently escalates.
    const tamperBin = process.platform === 'win32' ? 'js-tamper.exe' : 'js-tamper';
    fs.writeFileSync(path.join(jsRoot, tamperBin), '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(path.join(jsRoot, tamperBin), 0o755);
    fs.writeFileSync(
      path.join(jsRoot, 'offckb-tool.json'),
      JSON.stringify({
        apiVersion: 1,
        name: 'js-tamper',
        version: '1.0.0',
        command: 'js-tamper',
        description: 'Native js-tamper',
        entry: tamperBin,
        permissions: [],
      }),
    );
    const tampered = acquirePlugin('js-tamper');
    try {
      expect(tampered.plugin.kind).toBe('binary');
      expect(tampered.mode).toBe('sandbox');
    } finally {
      tampered.release();
    }

    // A MANAGED native registration whose directory is swapped to a JS
    // manifest must still fail closed.
    commitTool();
    fs.rmSync(path.join(pluginNativeDir(command), 'offckb-tool.json'));
    fs.writeFileSync(path.join(pluginNativeDir(command), 'x.mjs'), '');
    fs.writeFileSync(
      path.join(pluginNativeDir(command), 'package.json'),
      JSON.stringify({ name: 'my-tool', version: '0.1.0', offckb: { apiVersion: 1, command, entry: 'x.mjs' } }),
    );
    expect(() => acquirePlugin(command)).toThrow('registration kind changed');
  });

  it('links local binary tool directories like local development tools', () => {
    const binaryDir = path.join(root, 'linked-binary');
    fs.mkdirSync(binaryDir);
    const linkedBin = process.platform === 'win32' ? 'tool.exe' : 'tool';
    fs.writeFileSync(path.join(binaryDir, linkedBin), '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(path.join(binaryDir, linkedBin), 0o755);
    fs.writeFileSync(
      path.join(binaryDir, 'offckb-tool.json'),
      JSON.stringify({
        apiVersion: 1,
        name: 'linked-binary',
        version: '0.1.0',
        command: 'linked-binary',
        description: 'Linked binary tool',
        entry: linkedBin,
        permissions: [],
      }),
    );
    // Local directories are user-consented (like running the binary
    // directly): they link in place, default to sandbox mode, and unregister
    // with unlink like any local link.
    linkPlugin(binaryDir, new Set());
    const [info] = listPlugins(new Set());
    expect(info).toMatchObject({ command: 'linked-binary', kind: 'binary', mode: 'sandbox', state: 'available' });
    expect(getNativeBinaryPath('linked-binary')).toBeNull(); // no managed stable path
    unlinkPlugin('linked-binary');
    expect(listPlugins(new Set())).toEqual([]);

    // The npm install path still refuses binary descriptors: remote packages
    // must come through the native installer.
    expect(() =>
      commitPluginInstallation(
        binaryDir,
        {
          id: '11111111-2222-4333-8444-555555555555',
          name: 'linked-binary',
          source: { kind: 'npm', requested: 'linked-binary', resolved: 'linked-binary@0.1.0' },
          allowScripts: false,
        },
        new Set(),
        {},
      ),
    ).toThrow('binary tool descriptor');
  });

  it('routes binary tools to plugin remove instead of unlink', () => {
    commitTool();
    expect(() => unlinkPlugin(command)).toThrow('plugin remove');
  });

  it('rolls the directory swap back when the registry write fails', () => {
    commitTool('v0.1.0');
    const binName = process.platform === 'win32' ? 'my-tool.exe' : 'my-tool';
    const dir = pluginNativeDir(command);
    const before = fs.readFileSync(path.join(dir, binName), 'utf8');

    // Fail precisely the atomic registry rename; the swap itself succeeds.
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((...args: unknown[]) => {
      if (String(args[1]).endsWith(`${path.sep}registry.json`)) {
        throw new Error('injected registry write failure');
      }
      return (realRename as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.renameSync);
    try {
      expect(() => commitTool('v0.2.0')).toThrow('injected registry write failure');
    } finally {
      renameSpy.mockRestore();
    }
    // The previous directory content is back, matching the untouched registration.
    expect(fs.readFileSync(path.join(dir, binName), 'utf8')).toBe(before);
    expect(getNativeBinaryPath(command)).toBe(path.join(dir, binName));
    expect(listPlugins(new Set())[0]).toMatchObject({ state: 'available', version: 'v0.1.0' });
    expect(fs.readdirSync(pluginNativeDir(command))).not.toEqual([]);
  });

  it('never treats a stale marker next to a replaced file as ownership', () => {
    const binDir = path.join(root, 'bin-stale');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      const target = path.join(root, 'managed-stale', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
      ensureCommandShim(command, target);
      const shimPath = path.join(binDir, process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool');
      expect(fs.existsSync(shimPath)).toBe(true);

      // The user replaces the shim with their own file; the sidecar is stale now.
      fs.writeFileSync(shimPath, '#!/bin/sh\necho user-owned\n');
      ensureCommandShim(command, target);
      expect(fs.readFileSync(shimPath, 'utf8')).toBe('#!/bin/sh\necho user-owned\n');
      removeCommandShims(command);
      expect(fs.existsSync(shimPath)).toBe(true);
      // The marker is only removed together with a file offckb actually owns.
      expect(fs.existsSync(shimMarkerPath(shimPath))).toBe(true);
    } finally {
      mockSpawnSync.mockReset();
    }
  });

  it('rejects one source claiming a second command', () => {
    commitTool('v0.1.0');
    // Same source id (my-tool) now declares a different command; the new
    // command has no registration yet, which must not bypass the check.
    expect(() => commitTool('v0.1.0', { command: 'my-tool-two' })).toThrow('changed its command');
    expect(getNativeBinaryPath('my-tool-two')).toBeNull();
  });

  it('rejects a registration whose directory escapes the native command root', () => {
    commitTool();
    const registryFile = path.join(home, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    registry.plugins[command].directory = path.join(root, 'elsewhere');
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    expect(() => listPlugins(new Set())).toThrow('Invalid plugin registry');
  });

  it('rejects a shim symlink even when the marker would match', () => {
    if (process.platform === 'win32') return; // symlink creation may require elevation.
    const binDir = path.join(root, 'bin-symlink');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      const target = path.join(root, 'managed-symlink', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
      ensureCommandShim(command, target);
      const shimPath = path.join(binDir, 'my-tool');
      fs.rmSync(shimPath);
      fs.symlinkSync(target, shimPath);
      // Re-ensure and remove: the symlink must survive both.
      ensureCommandShim(command, target);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
      removeCommandShims(command);
      expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
    } finally {
      mockSpawnSync.mockReset();
    }
  });

  it('ignores shims owned by a different plugin home', () => {
    const binDir = path.join(root, 'bin-home');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      const target = path.join(root, 'managed-home', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
      ensureCommandShim(command, target);
      const shimPath = path.join(binDir, process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool');
      const ownedContent = fs.readFileSync(shimPath, 'utf8');
      // Another OFFCKB_PLUGIN_HOME (e.g. an isolated test env) must neither
      // overwrite nor delete this home's shim.
      const currentHome = process.env.OFFCKB_PLUGIN_HOME;
      process.env.OFFCKB_PLUGIN_HOME = path.join(root, 'other-home');
      try {
        ensureCommandShim(command, target);
        expect(fs.readFileSync(shimPath, 'utf8')).toBe(ownedContent);
        removeCommandShims(command);
        expect(fs.existsSync(shimPath)).toBe(true);
      } finally {
        if (currentHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
        else process.env.OFFCKB_PLUGIN_HOME = currentHome;
      }
    } finally {
      mockSpawnSync.mockReset();
    }
  });

  it('never claims markerless embedded-marker shims while a custom home is set', () => {
    if (process.platform === 'win32') return; // focus on the POSIX shim layout.
    const binDir = path.join(root, 'bin-markerless');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      // A shim written by the pre-sidecar installer: embedded marker only.
      const shimPath = path.join(binDir, 'my-tool');
      fs.writeFileSync(shimPath, '#!/bin/sh\n# offckb-managed my-tool shim\nexec "/old/tool" "$@"\n');
      const target = path.join(root, 'managed-markerless', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v2\n');
      ensureCommandShim(command, target);
      // OFFCKB_PLUGIN_HOME is set in this suite, so ownership is not claimed
      // from an embedded comment alone.
      expect(fs.readFileSync(shimPath, 'utf8')).toContain('/old/tool');
      removeCommandShims(command);
      expect(fs.existsSync(shimPath)).toBe(true);
    } finally {
      mockSpawnSync.mockReset();
    }
  });

  it('refuses to install into or remove through a symlinked native root', () => {
    if (process.platform === 'win32') return; // symlink creation may require elevation.
    commitTool();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    // Keep the real tool under the future symlink target so the registration
    // stays valid: the assertion is that a refused removal deletes NOTHING.
    fs.renameSync(pluginNativeDir(command), path.join(outside, 'my-tool'));
    fs.rmSync(path.join(home, 'native'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(home, 'native'));

    expect(() => commitTool('v0.2.0')).toThrow('must not be a symlink');
    expect(() => removePlugin(command)).toThrow('must not be a symlink');
    // Mutation is refused and nothing was deleted or staged; discovery and
    // execution fail closed instead of resolving outside the plugin home.
    expect(fs.readdirSync(outside)).toEqual(['my-tool']);
    expect(getNativeBinaryPath(command)).toBeNull();
    expect(listPlugins(new Set())[0]).toMatchObject({ state: 'invalid', error: expect.stringContaining('symlink') });
    expect(() => acquirePlugin(command)).toThrow('symlink');

    // Restore the real root: the tool is discoverable and removable again.
    fs.unlinkSync(path.join(home, 'native'));
    fs.mkdirSync(path.join(home, 'native'));
    fs.renameSync(path.join(outside, 'my-tool'), pluginNativeDir(command));
    expect(getNativeBinaryPath(command)).not.toBeNull();
    expect(listPlugins(new Set())[0]).toMatchObject({ state: 'available', version: 'v0.1.0' });
    removePlugin(command);
    expect(getNativeBinaryPath(command)).toBeNull();
  });

  it('rejects a symlinked managed binary in the descriptor directory', () => {
    if (process.platform === 'win32') return; // symlink creation may require elevation.
    const dir = path.join(root, 'linked-binary-dir');
    const real = path.join(root, 'real-tool');
    fs.writeFileSync(real, '#!/bin/sh\n');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'my-tool'));
    fs.writeFileSync(
      path.join(dir, 'offckb-plugin.json'),
      JSON.stringify({
        apiVersion: 1,
        kind: 'binary',
        name: 'my-tool',
        version: 'v0.1.0',
        command: 'my-tool',
        binary: { name: 'my-tool' },
        release: { repo: 'owner/repo', asset: 'my-tool_{tag}_{target}.tar.gz', checksum: '{tag}-sha256.txt' },
      }),
    );
    const { readPluginManifest } = jest.requireActual('../src/plugins/manifest') as typeof import('../src/plugins/manifest');
    expect(() => readPluginManifest(dir)).toThrow('regular file');
  });

  it('fails closed when the managed binary is replaced by a symlink', () => {
    if (process.platform === 'win32') return; // symlink creation may require elevation.
    commitTool();
    const binaryPath = getNativeBinaryPath(command)!;
    const foreign = path.join(root, 'foreign-tool');
    fs.writeFileSync(foreign, '#!/bin/sh\n');
    fs.rmSync(binaryPath);
    fs.symlinkSync(foreign, binaryPath);

    // Every consumer channel fails closed: path lookup, env export and the
    // legacy debugger entry (which resolves through getNativeBinaryPath).
    expect(getNativeBinaryPath(command)).toBeNull();
    expect(nativeToolEnv()).toEqual({});
    expect(listPlugins(new Set())[0]).toMatchObject({ state: 'invalid' });
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
