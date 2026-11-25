import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

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
  acquirePlugin,
  assertNativeRootSafe,
  commitNativeRegistration,
  commitPluginInstallation,
  getNativeBinaryPath,
  linkPlugin,
  listNativeTools,
  listPlugins,
  nativeToolEnv,
  pluginNativeDir,
  removePlugin,
  unlinkPlugin,
} from '../src/plugins/store';
import { ensureCommandShim, removeCommandShims, shimMarkerPath } from '../src/plugins/shims';
import { logger } from '../src/util/logger';
import { dataPath } from '../src/cfg/setting';

// The default plugin home derives from dataPath; route it to a per-test temp
// directory so tests that drop OFFCKB_PLUGIN_HOME (the default-home reclaim
// paths) never read or mutate the developer's real plugin registry.
const mockDataRoot = { current: '' };
jest.mock('../src/cfg/setting', () => ({
  get dataPath() {
    return mockDataRoot.current;
  },
}));

let home: string;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-native-store-test-'));
  home = path.join(root, 'plugin-home');
  mockDataRoot.current = path.join(root, 'data-root');
  process.env.OFFCKB_PLUGIN_HOME = home;
});

afterEach(() => {
  delete process.env.OFFCKB_PLUGIN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('native tool registrations', () => {
  const command = 'my-tool';

  function fakeBinary(version: string): string {
    return `#!/bin/sh\necho my-tool ${version}\n`;
  }

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
    // A valid binary descriptor appearing in a linked directory changes the
    // registration kind after the fact. Linked binaries are not a supported
    // execution mode (binary tools are managed copies), so acquisition must
    // fail fast with the repair path instead of drifting into a runtime
    // sandbox error — the D5/D6 fail-closed rule at the registry boundary.
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
    expect(() => acquirePlugin('js-tamper')).toThrow(/registration kind changed/);

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
    const target = path.join(root, 'managed-stale', 'my-tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
    ensureCommandShim(command, target);
    // This suite runs with an isolated OFFCKB_PLUGIN_HOME: shims publish
    // under the home's own bin directory, never the global PATH.
    const shimPath = path.join(home, 'bin', process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool');
    expect(fs.existsSync(shimPath)).toBe(true);

    // The user replaces the shim with their own file; the sidecar is stale now.
    fs.writeFileSync(shimPath, '#!/bin/sh\necho user-owned\n');
    ensureCommandShim(command, target);
    expect(fs.readFileSync(shimPath, 'utf8')).toBe('#!/bin/sh\necho user-owned\n');
    removeCommandShims(command);
    expect(fs.existsSync(shimPath)).toBe(true);
    // The marker is only removed together with a file offckb actually owns.
    expect(fs.existsSync(shimMarkerPath(shimPath))).toBe(true);
  });

  it('rejects one source claiming a second command', () => {
    commitTool('v0.1.0');
    // Same source id (my-tool) now declares a different command; the new
    // command has no registration yet, which must not bypass the check.
    expect(() => commitTool('v0.1.0', { command: 'my-tool-two' })).toThrow('changed its command');
    expect(getNativeBinaryPath('my-tool-two')).toBeNull();
  });

  it('rejects a different source identity silently taking over a command', () => {
    commitTool('v0.1.0');
    // A descriptor with a new identity but the same command (e.g. a renamed
    // copy of a catalog descriptor) must not silently replace the owner.
    expect(() =>
      commitNativeRegistration(
        command,
        {
          binName: 'my-tool',
          version: 'v9.9.9',
          path: path.join(pluginNativeDir(command), 'my-tool'),
          source: { kind: 'descriptor', id: '@evil/my-tool-copy', requested: './copy.json', resolved: '@evil/my-tool-copy@v9.9.9' },
        },
        [],
        new Set(),
        () => undefined,
        () => undefined,
      ),
    ).toThrow('already owned by source "my-tool"; remove it first with: offckb plugin remove my-tool');
    // The original registration is untouched.
    expect(getNativeBinaryPath(command)).toBe(path.join(pluginNativeDir(command), process.platform === 'win32' ? 'my-tool.exe' : 'my-tool'));
  });

  it('still allows same-source upgrades after the ownership guard', () => {
    commitTool('v0.1.0');
    // Same source id, newer version: the supported upgrade path.
    commitTool('v0.2.0');
    const [info] = listPlugins(new Set());
    expect(info).toMatchObject({ command, version: 'v0.2.0', state: 'available' });
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
    const target = path.join(root, 'managed-symlink', 'my-tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
    ensureCommandShim(command, target);
    const shimPath = path.join(home, 'bin', 'my-tool');
    fs.rmSync(shimPath);
    fs.symlinkSync(target, shimPath);
    // Re-ensure and remove: the symlink must survive both.
    ensureCommandShim(command, target);
    expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
    removeCommandShims(command);
    expect(fs.lstatSync(shimPath).isSymbolicLink()).toBe(true);
  });

  it('keeps every home inside its own bin directory', () => {
    const target = path.join(root, 'managed-home', 'my-tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
    ensureCommandShim(command, target);
    const shimName = process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool';
    const shimPath = path.join(home, 'bin', shimName);
    const ownedContent = fs.readFileSync(shimPath, 'utf8');
    // Another OFFCKB_PLUGIN_HOME (e.g. an isolated test env) publishes into
    // its own bin directory: this home's shim is neither overwritten nor
    // deleted, and the other home's remove stays inside its own bin too.
    const currentHome = process.env.OFFCKB_PLUGIN_HOME;
    process.env.OFFCKB_PLUGIN_HOME = path.join(root, 'other-home');
    try {
      ensureCommandShim(command, target);
      const otherShim = path.join(root, 'other-home', 'bin', shimName);
      expect(fs.existsSync(otherShim)).toBe(true);
      expect(fs.readFileSync(shimPath, 'utf8')).toBe(ownedContent);
      removeCommandShims(command);
      expect(fs.existsSync(otherShim)).toBe(false);
      expect(fs.existsSync(shimPath)).toBe(true);
    } finally {
      if (currentHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
      else process.env.OFFCKB_PLUGIN_HOME = currentHome;
    }
  });

  it('never touches the global bin directory while an isolated home is set', () => {
    if (process.platform === 'win32') return; // focus on the POSIX shim layout.
    const binDir = path.join(root, 'bin-global');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    // A legacy shim planted on the global PATH by the pre-sidecar installer:
    // an isolated home must not claim it, and must not write beside it.
    const legacyShim = path.join(binDir, 'my-tool');
    fs.writeFileSync(legacyShim, '#!/bin/sh\n# offckb-managed my-tool shim\nexec "/old/tool" "$@"\n');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      const target = path.join(root, 'managed-markerless', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v2\n');
      ensureCommandShim(command, target);
      // The shim lands under the isolated home's own bin directory; the
      // global bin directory is left completely untouched.
      expect(fs.existsSync(path.join(home, 'bin', 'my-tool'))).toBe(true);
      expect(fs.readdirSync(binDir).sort()).toEqual(['my-tool', 'offckb']);
      expect(fs.readFileSync(legacyShim, 'utf8')).toContain('/old/tool');
      removeCommandShims(command);
      expect(fs.existsSync(path.join(home, 'bin', 'my-tool'))).toBe(false);
      expect(fs.existsSync(legacyShim)).toBe(true);
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

  it('shim exits 127 with an actionable error when the managed binary is gone', () => {
    if (process.platform === 'win32') return; // POSIX shell guard.
    const target = path.join(root, 'managed-guard', 'my-tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\necho alive\n', { mode: 0o755 });
    ensureCommandShim(command, target);
    const shimPath = path.join(home, 'bin', 'my-tool');
    const realSpawn = jest.requireActual('child_process').spawnSync as typeof import('child_process').spawnSync;
    // While the target exists the shim execs it.
    expect(realSpawn(shimPath, [], { encoding: 'utf8' }).stdout).toContain('alive');
    // Once the target disappears the shim explains the repair instead of a
    // bare shell "no such file".
    fs.rmSync(target);
    const result = realSpawn(shimPath, [], { encoding: 'utf8' });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('offckb-managed binary is missing');
    // No install hint was provided: the repair message stays generic instead
    // of guessing a spec from the command name.
    expect(result.stderr).toContain('Reinstall the tool from its original source');
  });

  it('shim survives spaces and parentheses in the managed binary path', () => {
    if (process.platform === 'win32') return; // POSIX shell execution.
    const dir = path.join(root, 'managed dir (v2)');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'my-tool');
    fs.writeFileSync(target, '#!/bin/sh\necho spaced\n', { mode: 0o755 });
    ensureCommandShim(command, target);
    const shimPath = path.join(home, 'bin', 'my-tool');
    const realSpawn = jest.requireActual('child_process').spawnSync as typeof import('child_process').spawnSync;
    expect(realSpawn(shimPath, [], { encoding: 'utf8' }).stdout).toContain('spaced');
    fs.rmSync(target);
    const result = realSpawn(shimPath, [], { encoding: 'utf8' });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('offckb-managed binary is missing');
  });

  it('uses a provided install hint and stays generic without one', () => {
    const target = path.join(root, 'managed-hint', 'my-tool');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\necho v1\n');
    const shimPath = path.join(home, 'bin', process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool');
    // A catalog tool: the command name is a stable reinstall spec.
    ensureCommandShim(command, target, 'my-tool');
    expect(fs.readFileSync(shimPath, 'utf8')).toContain('offckb plugin install my-tool');
    // A non-catalog tool (e.g. a local descriptor directory): no spec is
    // embedded — relative paths depend on the repair-time working directory
    // and user-supplied strings do not belong in generated shell source.
    ensureCommandShim(command, target);
    const content = fs.readFileSync(shimPath, 'utf8');
    expect(content).toContain('Reinstall the tool from its original source');
    expect(content).not.toContain('offckb plugin install');
  });

  describe('orphan shim reclaim on the global PATH', () => {
    let binDir: string;

    beforeEach(() => {
      binDir = path.join(root, 'bin-orphan');
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, 'offckb'), '');
      mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
        if (cmd === 'which' || cmd === 'where') {
          return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
        }
        return jest.requireActual('child_process').spawnSync(cmd, args, options);
      });
      // Orphans are reclaimed by the DEFAULT home: drop the isolation env.
      delete process.env.OFFCKB_PLUGIN_HOME;
    });

    afterEach(() => {
      process.env.OFFCKB_PLUGIN_HOME = home;
      mockSpawnSync.mockReset();
    });

    // A global shim as the pre-gate installer wrote it: sidecar marker
    // recording the owning home. No embedded marker comment, so ownership
    // can only come from the sidecar path under test. On Windows the
    // extensionless shim never lands on PATH (only .cmd/.exe do), so plant
    // the .cmd form there.
    const deadTarget = process.platform === 'win32' ? 'C:\\dead\\home\\my-tool.exe' : '/dead/home/my-tool';
    function plantShim(owningHome: string): string {
      const shimPath = path.join(binDir, process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool');
      const content =
        process.platform === 'win32' ? `@echo off\r\n"${deadTarget}" %*\r\n` : `#!/bin/sh\nexec "${deadTarget}" "$@"\n`;
      fs.writeFileSync(shimPath, content);
      fs.writeFileSync(
        shimMarkerPath(shimPath),
        JSON.stringify({ v: 1, command, sha256: createHash('sha256').update(content).digest('hex'), home: owningHome }) + '\n',
      );
      return shimPath;
    }

    it('remove reclaims a shim whose owning home no longer exists', () => {
      const shimPath = plantShim(path.join(root, 'dead-home')); // never created
      removeCommandShims(command);
      expect(fs.existsSync(shimPath)).toBe(false);
      expect(fs.existsSync(shimMarkerPath(shimPath))).toBe(false);
    });

    it('install adopts an orphan shim and repoints it at the live binary', () => {
      const shimPath = plantShim(path.join(root, 'dead-home'));
      const target = path.join(root, 'managed-orphan', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v2\n');
      ensureCommandShim(command, target);
      expect(fs.readFileSync(shimPath, 'utf8')).toContain(target);
    });

    it('still refuses a shim whose owning home exists, and names that home', () => {
      const liveHome = path.join(root, 'live-home');
      fs.mkdirSync(liveHome);
      const shimPath = plantShim(liveHome);
      removeCommandShims(command);
      expect(fs.existsSync(shimPath)).toBe(true);
      const target = path.join(root, 'managed-live', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v2\n');
      ensureCommandShim(command, target);
      expect(fs.readFileSync(shimPath, 'utf8')).toContain(deadTarget);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(liveHome));
    });

    it('the public plugin remove reclaims an orphan even without a registration', () => {
      const shimPath = plantShim(path.join(root, 'dead-home'));
      // removePlugin still reports the missing registration, but the orphan
      // on the PATH must not survive the attempt.
      expect(() => removePlugin(command)).toThrow('not linked');
      expect(fs.existsSync(shimPath)).toBe(false);
      expect(fs.existsSync(shimMarkerPath(shimPath))).toBe(false);
    });

    it('fails closed when the owning home cannot be stat’d (permission error)', () => {
      if (process.platform === 'win32') return; // POSIX permission model.
      if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses chmod.
      const lockedParent = path.join(root, 'locked');
      fs.mkdirSync(lockedParent);
      const hiddenHome = path.join(lockedParent, 'home');
      fs.mkdirSync(hiddenHome);
      const shimPath = plantShim(hiddenHome); // home exists, just unreadable
      fs.chmodSync(lockedParent, 0o000);
      try {
        removeCommandShims(command);
        expect(fs.existsSync(shimPath)).toBe(true);
      } finally {
        fs.chmodSync(lockedParent, 0o755);
      }
    });
  });

  it('treats OFFCKB_PLUGIN_HOME set to the default home as non-isolated', () => {
    const binDir = path.join(root, 'bin-explicit-default');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'offckb'), '');
    mockSpawnSync.mockImplementation((cmd: string, args: unknown[], options: unknown) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(binDir, 'offckb')}\n`, stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, options);
    });
    try {
      // Explicitly naming the default home must behave exactly like leaving
      // OFFCKB_PLUGIN_HOME unset: global PATH shims, not <home>/bin.
      process.env.OFFCKB_PLUGIN_HOME = path.join(dataPath, 'plugins');
      const target = path.join(root, 'managed-explicit-default', 'my-tool');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '#!/bin/sh\necho v2\n');
      ensureCommandShim(command, target);
      const shimName = process.platform === 'win32' ? 'my-tool.cmd' : 'my-tool';
      expect(fs.existsSync(path.join(binDir, shimName))).toBe(true);
      expect(fs.existsSync(path.join(dataPath, 'plugins', 'bin', shimName))).toBe(false);
    } finally {
      mockSpawnSync.mockReset();
    }
  });

  it('remove deletes the managed directory and only offckb-owned shims', () => {
    const isWindows = process.platform === 'win32';
    commitTool();
    // Shims are published by the install pipeline, not by the store commit;
    // create them as the installer would, then verify removal keeps only
    // what offckb owns.
    ensureCommandShim(command, getNativeBinaryPath(command)!);
    const binaryPath = getNativeBinaryPath(command)!;
    expect(fs.existsSync(binaryPath)).toBe(true);
    const shimPath = path.join(home, 'bin', isWindows ? 'my-tool.cmd' : 'my-tool');
    const exePath = path.join(home, 'bin', 'my-tool.exe');
    expect(fs.existsSync(shimPath)).toBe(true);
    // A foreign file next to the owned shim must survive removal.
    const foreignPath = path.join(home, 'bin', isWindows ? 'my-tool.ps1' : 'my-tool-foreign');
    fs.writeFileSync(foreignPath, 'foreign');

    removePlugin(command);

    expect(fs.existsSync(binaryPath)).toBe(false);
    expect(fs.existsSync(pluginNativeDir(command))).toBe(false);
    expect(fs.existsSync(shimPath)).toBe(false);
    if (isWindows) expect(fs.existsSync(exePath)).toBe(false);
    expect(fs.existsSync(foreignPath)).toBe(true);
    expect(getNativeBinaryPath(command)).toBeNull();
  });
});
