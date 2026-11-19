import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as tar from 'tar';
import { spawnSync } from 'child_process';
import { Request } from '../src/util/request';

const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));
jest.mock('../src/util/request', () => ({
  Request: { send: jest.fn(), fetch: jest.fn() },
}));
jest.mock('../src/util/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    result: jest.fn(),
  },
}));

const mockDirs = { dataRoot: '', toolsRoot: '', shimBin: '' };
const mockMinVersion = { current: '0.200.0' };
const probeVersion = { current: '1.1.2' };

jest.mock('../src/cfg/setting', () => ({
  get dataPath() {
    return mockDirs.dataRoot;
  },
  readSettings: () => ({
    proxy: undefined,
    tools: {
      rootFolder: mockDirs.toolsRoot,
      ckbDebugger: { minVersion: mockMinVersion.current },
    },
  }),
}));

import { installPlugin, parsePluginInstallSpec } from '../src/plugins/install';
import { probeBinaryDescriptor } from '../src/plugins/native';
import {
  addTrustedSource,
  getNativeBinaryPath,
  listNativeTools,
  listTrustedSources,
  pluginNativeDir,
  removePlugin,
} from '../src/plugins/store';

const requestSend = Request.send as jest.Mock;
const requestFetch = Request.fetch as jest.Mock;

// Install-flow tests pin the host to linux/x64 so the download/install
// assertions are host-independent: upstream publishes no Intel-macOS asset,
// and a POSIX-shell fixture cannot run on Windows.
const TARGET = 'x86_64-unknown-linux-gnu';
const BINARY_NAME = 'ckb-debugger';
const originalPlatform = process.platform;
const originalArch = process.arch;

function mockHost(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

let home: string;
let root: string;

beforeEach(() => {
  jest.clearAllMocks();
  mockHost('linux', 'x64');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-native-test-'));
  home = path.join(root, 'plugin-home');
  mockDirs.dataRoot = root;
  mockDirs.toolsRoot = path.join(root, 'tools');
  mockDirs.shimBin = path.join(root, 'bin');
  fs.mkdirSync(mockDirs.shimBin);
  fs.writeFileSync(path.join(mockDirs.shimBin, 'offckb'), '');
  probeVersion.current = '1.1.2';
  mockMinVersion.current = '0.200.0';
  mockSpawnSync.mockImplementation((cmd: string) => {
    if (cmd === 'which' || cmd === 'where') {
      return { status: 0, stdout: `${path.join(mockDirs.shimBin, 'offckb')}\n`, stderr: '' };
    }
    // Every ckb-debugger binary (staged, installed, legacy) reports the
    // configurable probe version, so no fixture has to be executable here.
    return { status: 0, stdout: `ckb-debugger ${probeVersion.current}\n`, stderr: '' };
  });
  process.env.OFFCKB_PLUGIN_HOME = home;
});

afterEach(() => {
  delete process.env.OFFCKB_PLUGIN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
  mockHost(originalPlatform, originalArch);
});

function buildTarGz(binary: string, version: string): Promise<Buffer> {
  // Use the cross-platform `tar` npm package (not the system tar binary):
  // on Windows, GNU tar misreads the "C:\" drive prefix in temp paths as a
  // remote host and fails, which breaks test-fixture creation there.
  return (async () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-native-stage-'));
    try {
      fs.writeFileSync(path.join(stage, binary), fakeBinaryPayload(version));
      const archivePath = path.join(stage, 'archive.tar.gz');
      await tar.c({ gzip: true, file: archivePath, cwd: stage }, [binary]);
      return fs.readFileSync(archivePath);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  })();
}

function mockDebuggerRelease(version: string, buffer: Buffer) {
  const tag = `v${version}`;
  requestSend.mockImplementation(async (url: string) => {
    if (url.includes('/releases/latest')) {
      return {
        url: `https://github.com/nervosnetwork/ckb-standalone-debugger/releases/tag/${tag}`,
      };
    }
    if (url.endsWith('-sha256.txt')) {
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      return { text: async () => `${digest}  ckb-debugger_${tag}_${TARGET}.tar.gz` };
    }
    return { arrayBuffer: async () => buffer };
  });
}

function fakeBinaryPayload(version: string): string {
  return `#!/bin/sh\necho "ckb-debugger ${version}"\n`;
}

describe('parsePluginInstallSpec', () => {
  it('resolves catalog names before npm package names', () => {
    const spec = parsePluginInstallSpec('ckb-debugger');
    expect(spec.kind).toBe('catalog');
    expect(spec.ref).toBe('latest');
    const pinned = parsePluginInstallSpec('ckb-debugger@v1.1.2');
    expect(pinned.kind).toBe('catalog');
    expect(pinned.ref).toBe('v1.1.2');
    // An npm package that literally shares the catalog name stays reachable.
    expect(parsePluginInstallSpec('npm:ckb-debugger').kind).toBe('npm');
  });
});

describe('binary tool installation', () => {
  it('installs the catalog ckb-debugger at a stable path with a registry entry and PATH shim', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);

    const { plugin, source } = await installPlugin('ckb-debugger', new Set(), {});

    expect(plugin.kind).toBe('binary');
    expect(source).toEqual({ kind: 'catalog', id: 'ckb-debugger', requested: 'ckb-debugger', resolved: 'ckb-debugger@v1.1.2' });
    const binaryPath = path.join(pluginNativeDir('ckb-debugger'), BINARY_NAME);
    expect(plugin.directory).toBe(fs.realpathSync(pluginNativeDir('ckb-debugger')));
    expect(fs.existsSync(binaryPath)).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 1.1.2"');
    // The descriptor written next to the binary re-declares the tool statically.
    const descriptor = JSON.parse(fs.readFileSync(path.join(plugin.directory, 'offckb-plugin.json'), 'utf8'));
    expect(descriptor).toMatchObject({ apiVersion: 1, kind: 'binary', command: 'ckb-debugger', version: 'v1.1.2' });
    // Registry record exposes the stable path for tools and env export.
    expect(getNativeBinaryPath('ckb-debugger')).toBe(binaryPath);
    expect(listNativeTools()).toEqual([
      { command: 'ckb-debugger', envName: 'OFFCKB_TOOL_CKB_DEBUGGER', path: binaryPath },
    ]);
    // PATH shim next to the offckb binary, with an ownership marker.
    const shimPath = path.join(mockDirs.shimBin, BINARY_NAME);
    expect(fs.existsSync(shimPath)).toBe(true);
    expect(fs.existsSync(`${shimPath}.offckb`)).toBe(true);
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(binaryPath);
    expect(requestSend).toHaveBeenCalledTimes(3); // latest redirect + archive + sha256.txt
  });

  it('checks the remote tag and skips the archive download when already current', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    await installPlugin('ckb-debugger', new Set(), {});
    requestSend.mockClear();

    const { source } = await installPlugin('ckb-debugger', new Set(), {});

    expect(source.resolved).toBe('ckb-debugger@v1.1.2');
    // Only the latest-tag redirect probe: no archive or checksum download.
    expect(requestSend).toHaveBeenCalledTimes(1);
    expect(String(requestSend.mock.calls[0][0])).toContain('/releases/latest');
  });

  it('never touches the network when reinstalling an exact tag', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    await installPlugin('ckb-debugger', new Set(), {});
    requestSend.mockClear();

    const { source } = await installPlugin('ckb-debugger@v1.1.2', new Set(), {});

    expect(source.resolved).toBe('ckb-debugger@v1.1.2');
    expect(requestSend).not.toHaveBeenCalled();
  });

  it('upgrades atomically at the same stable path', async () => {
    const first = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', first);
    const before = await installPlugin('ckb-debugger', new Set(), {});
    const stablePath = getNativeBinaryPath('ckb-debugger')!;

    const second = await buildTarGz(BINARY_NAME, '1.1.3');
    mockDebuggerRelease('1.1.3', second);
    probeVersion.current = '1.1.3';
    const after = await installPlugin('ckb-debugger@latest', new Set(), {});

    expect(after.source.resolved).toBe('ckb-debugger@v1.1.3');
    expect(getNativeBinaryPath('ckb-debugger')).toBe(stablePath);
    expect(before.plugin.directory).toBe(after.plugin.directory);
    expect(fs.readFileSync(stablePath, 'utf-8')).toContain('echo "ckb-debugger 1.1.3"');
  });

  it('fails closed when the downloaded checksum does not match', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return {
          url: 'https://github.com/nervosnetwork/ckb-standalone-debugger/releases/tag/v1.1.2',
        };
      }
      if (url.endsWith('-sha256.txt')) {
        return { text: async () => `${'0'.repeat(64)}  archive.tar.gz` };
      }
      return { arrayBuffer: async () => buffer };
    });

    await expect(installPlugin('ckb-debugger', new Set(), {})).rejects.toThrow('checksum mismatch');
    expect(getNativeBinaryPath('ckb-debugger')).toBeNull();
  });

  it('rejects platforms without a prebuilt asset', async () => {
    mockHost('darwin', 'x64'); // upstream publishes no Intel-macOS asset
    await expect(installPlugin('ckb-debugger', new Set(), {})).rejects.toThrow(/no prebuilt binary/);
  });

  it('removes the staged binary and throws when it cannot run --version', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `${path.join(mockDirs.shimBin, 'offckb')}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    await expect(installPlugin('ckb-debugger', new Set(), {})).rejects.toThrow(/failed to run `--version`/);
    expect(getNativeBinaryPath('ckb-debugger')).toBeNull();
  });

  it('warns but installs an explicitly pinned version below the recommended minimum', async () => {
    mockMinVersion.current = '9.9.9';
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    const { logger } = jest.requireMock('../src/util/logger') as { logger: { warn: jest.Mock } };

    const { source } = await installPlugin('ckb-debugger', new Set(), {});

    expect(source.resolved).toBe('ckb-debugger@v1.1.2');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('below the recommended minimum'));
  });

  it('adopts a leftover pre-plugin install instead of re-downloading it', async () => {
    // The probed (not executed) version of every fixture binary in this test.
    probeVersion.current = '1.1.1';
    const legacyDir = path.join(mockDirs.toolsRoot, 'ckb-debugger');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, BINARY_NAME), fakeBinaryPayload('1.1.1'));

    const { source } = await installPlugin('ckb-debugger', new Set(), {});

    // The adoption is offline and records the version read from the binary itself.
    expect(source.resolved).toBe('ckb-debugger@1.1.1');
    expect(requestSend).not.toHaveBeenCalled();
    // The leftover directory is gone; the binary moved to the stable path.
    expect(fs.existsSync(legacyDir)).toBe(false);
    const binaryPath = getNativeBinaryPath('ckb-debugger')!;
    expect(fs.existsSync(binaryPath)).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 1.1.1"');
  });

  it('does not clobber a foreign file at the shim location', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    const shimPath = path.join(mockDirs.shimBin, BINARY_NAME);
    fs.writeFileSync(shimPath, '#!/bin/sh\necho foreign\n');
    const { logger } = jest.requireMock('../src/util/logger') as { logger: { warn: jest.Mock } };

    await installPlugin('ckb-debugger', new Set(), {});

    expect(fs.readFileSync(shimPath, 'utf8')).toBe('#!/bin/sh\necho foreign\n');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('leaving it untouched'));
  });

  it('remove deletes the managed binary and the offckb-owned shim', async () => {
    const buffer = await buildTarGz(BINARY_NAME, '1.1.2');
    mockDebuggerRelease('1.1.2', buffer);
    await installPlugin('ckb-debugger', new Set(), {});
    const binaryPath = getNativeBinaryPath('ckb-debugger')!;
    const shimPath = path.join(mockDirs.shimBin, BINARY_NAME);

    removePlugin('ckb-debugger');

    expect(fs.existsSync(binaryPath)).toBe(false);
    expect(fs.existsSync(pluginNativeDir('ckb-debugger'))).toBe(false);
    expect(fs.existsSync(shimPath)).toBe(false);
    expect(getNativeBinaryPath('ckb-debugger')).toBeNull();
  });
});

describe('third-party GitHub binary tools and the trusted-source allowlist', () => {
  const descriptor = {
    apiVersion: 1,
    kind: 'binary',
    name: 'my-tool',
    command: 'my-tool',
    binary: { name: 'my-tool' },
    release: {
      repo: 'someuser/my-tool',
      asset: 'my-tool_{tag}_{target}.tar.gz',
      checksum: '{asset}-sha256.txt',
    },
  };

  function mockToolRelease(version: string) {
    return (async () => {
      const buffer = await buildTarGz('my-tool', version);
      const tag = `v${version}`;
      requestSend.mockImplementation(async (url: string) => {
        if (url.includes('/releases/latest')) {
          return { url: `https://github.com/someuser/my-tool/releases/tag/${tag}` };
        }
        if (url.endsWith('-sha256.txt')) {
          const digest = crypto.createHash('sha256').update(buffer).digest('hex');
          return { text: async () => `${digest}  my-tool_${tag}_${TARGET}.tar.gz` };
        }
        return { arrayBuffer: async () => buffer };
      });
      requestFetch.mockImplementation(async (url: string) => {
        expect(url).toContain('raw.githubusercontent.com/someuser/my-tool/');
        return { status: 200, ok: true, json: async () => descriptor };
      });
      return buffer;
    })();
  }

  it('refuses a third-party binary source that is not in the allowlist', async () => {
    await mockToolRelease('0.1.0');

    await expect(installPlugin('github:someuser/my-tool', new Set(), {})).rejects.toThrow(
      /trusted-source allowlist/,
    );
    expect(listTrustedSources()).toEqual([]);
    expect(getNativeBinaryPath('my-tool')).toBeNull();
  });

  it('installs after an explicit trust add, without re-prompting on upgrade', async () => {
    await mockToolRelease('0.1.0');
    addTrustedSource('someuser/my-tool');

    const first = await installPlugin('github:someuser/my-tool', new Set(), {});
    expect(first.source.resolved).toBe('github:someuser/my-tool#v0.1.0');
    expect(getNativeBinaryPath('my-tool')).toBe(path.join(pluginNativeDir('my-tool'), 'my-tool'));

    await mockToolRelease('0.2.0');
    const second = await installPlugin('github:someuser/my-tool', new Set(), {});
    expect(second.source.resolved).toBe('github:someuser/my-tool#v0.2.0');
  });

  it('approves and installs in one step with --trust-source', async () => {
    await mockToolRelease('0.1.0');

    const { source } = await installPlugin('github:someuser/my-tool', new Set(), {
      trustSource: 'someuser/my-tool',
    });

    expect(source.resolved).toBe('github:someuser/my-tool#v0.1.0');
    expect(listTrustedSources()).toEqual(['someuser/my-tool']);
  });

  it('rejects a descriptor that pins binaries from a different repository', async () => {
    await mockToolRelease('0.1.0');
    requestFetch.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ...descriptor, release: { ...descriptor.release, repo: 'other/repo' } }),
    }));
    addTrustedSource('someuser/my-tool');

    await expect(installPlugin('github:someuser/my-tool', new Set(), {})).rejects.toThrow(
      /pins binaries from other\/repo/,
    );
    expect(getNativeBinaryPath('my-tool')).toBeNull();
  });

  it('keeps the legacy binary in place when the adoption commit fails', async () => {
    probeVersion.current = '1.1.1';
    const legacyDir = path.join(mockDirs.toolsRoot, 'ckb-debugger');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, BINARY_NAME), fakeBinaryPayload('1.1.1'));

    // A core-command conflict aborts the registry commit after staging.
    await expect(installPlugin('ckb-debugger', new Set(['ckb-debugger']), {})).rejects.toThrow('core command');

    // No data loss: the leftover install is untouched and no staging remains.
    expect(fs.existsSync(path.join(legacyDir, BINARY_NAME))).toBe(true);
    expect(fs.readdirSync(path.join(home, 'native')).filter((name) => name.includes('.staging-'))).toEqual([]);
    expect(getNativeBinaryPath('ckb-debugger')).toBeNull();
  });

  it('does not persist --trust-source approval when the install fails', async () => {
    await mockToolRelease('0.1.0');

    // A core-command conflict aborts the commit after the one-shot approval.
    await expect(
      installPlugin('github:someuser/my-tool', new Set(['my-tool']), { trustSource: 'someuser/my-tool' }),
    ).rejects.toThrow('core command');

    // The failed install must leave no permanent trust behind.
    expect(listTrustedSources()).toEqual([]);
    expect(getNativeBinaryPath('my-tool')).toBeNull();
  });

  it('treats a missing descriptor as a JS plugin source instead', async () => {
    requestFetch.mockImplementation(async () => ({ status: 404, ok: false }));

    // No descriptor: not a binary tool; probing is how the installer decides.
    expect(await probeBinaryDescriptor('someuser/not-a-tool')).toBeNull();
    // --trust-source without a binary descriptor is rejected before any npm install runs.
    await expect(
      installPlugin('github:someuser/not-a-tool', new Set(), { trustSource: 'someuser/not-a-tool' }),
    ).rejects.toThrow(/--trust-source only applies to binary tool sources/);
    expect(listTrustedSources()).toEqual([]);
  });
});
