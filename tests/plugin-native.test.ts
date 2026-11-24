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
import { installNativeTool, probeBinaryDescriptor } from '../src/plugins/native';
import { catalogEntry } from '../src/plugins/catalog';
import {
  addTrustedSource,
  getNativeBinaryPath,
  listNativeTools,
  listTrustedSources,
  pluginNativeDir,
  removePlugin,
  removeTrustedSource,
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
  // The catalog is the real tools/ directory: ckb-debugger pins v1.1.2 with
  // upstream SHA-256 digests, so download-level coverage lives in the
  // descriptor installer tests (fixture digests) and the binary smoke
  // (real archive). These tests exercise dispatch, version pinning and the
  // fully offline paths (legacy adoption and idempotent reinstall).
  function seedLegacyInstall(version: string): string {
    const legacyDir = path.join(mockDirs.toolsRoot, 'ckb-debugger');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, BINARY_NAME), fakeBinaryPayload(version));
    return legacyDir;
  }

  it('rejects a version the catalog does not pin', async () => {
    await expect(installPlugin('ckb-debugger@v9.9.9', new Set(), {})).rejects.toThrow(
      /catalog pins ckb-debugger at v1\.1\.2/,
    );
    expect(requestSend).not.toHaveBeenCalled();
  });

  it('installs the catalog ckb-debugger at a stable path with a registry entry and PATH shim', async () => {
    probeVersion.current = '1.1.2';
    seedLegacyInstall('1.1.2');

    const { plugin, source } = await installPlugin('ckb-debugger', new Set(), {});

    expect(plugin.kind).toBe('binary');
    expect(source).toEqual({ kind: 'catalog', id: 'ckb-debugger', requested: 'ckb-debugger', resolved: 'ckb-debugger@1.1.2' });
    const binaryPath = path.join(pluginNativeDir('ckb-debugger'), BINARY_NAME);
    expect(plugin.directory).toBe(fs.realpathSync(pluginNativeDir('ckb-debugger')));
    expect(fs.existsSync(binaryPath)).toBe(true);
    // The canonical descriptor written next to the binary re-declares the tool statically.
    const descriptor = JSON.parse(fs.readFileSync(path.join(plugin.directory, 'offckb-tool.json'), 'utf8'));
    expect(descriptor).toMatchObject({
      apiVersion: 1,
      command: 'ckb-debugger',
      version: '1.1.2',
      entry: BINARY_NAME,
      permissions: [],
    });
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
  });

  it('never touches the network when reinstalling, with or without an exact version', async () => {
    probeVersion.current = '1.1.2';
    seedLegacyInstall('1.1.2');
    await installPlugin('ckb-debugger', new Set(), {});
    requestSend.mockClear();
    const fetchSpy = jest.spyOn(global, 'fetch');

    const again = await installPlugin('ckb-debugger', new Set(), {});
    const pinned = await installPlugin('ckb-debugger@v1.1.2', new Set(), {});

    expect(again.source.resolved).toBe('ckb-debugger@1.1.2');
    expect(pinned.source.resolved).toBe('ckb-debugger@1.1.2');
    expect(requestSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects platforms the pinned descriptor does not ship', async () => {
    mockHost('darwin', 'x64'); // upstream publishes no Intel-macOS asset for v1.1.2
    await expect(installPlugin('ckb-debugger', new Set(), {})).rejects.toThrow(/has no binary for darwin\/x64/);
  });

  it('adopts a leftover pre-plugin install instead of re-downloading it', async () => {
    // The probed (not executed) version of every fixture binary in this test.
    probeVersion.current = '1.1.1';
    const legacyDir = seedLegacyInstall('1.1.1');

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
    probeVersion.current = '1.1.2';
    seedLegacyInstall('1.1.2');
    const shimPath = path.join(mockDirs.shimBin, BINARY_NAME);
    fs.writeFileSync(shimPath, '#!/bin/sh\necho foreign\n');
    const { logger } = jest.requireMock('../src/util/logger') as { logger: { warn: jest.Mock } };

    await installPlugin('ckb-debugger', new Set(), {});

    expect(fs.readFileSync(shimPath, 'utf8')).toBe('#!/bin/sh\necho foreign\n');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('leaving it untouched'));
  });

  it('remove deletes the managed binary and the offckb-owned shim', async () => {
    probeVersion.current = '1.1.2';
    seedLegacyInstall('1.1.2');
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
  const toolDescriptor = (version: string, permissions: string[] = []) => ({
    apiVersion: 1,
    name: 'my-tool',
    version,
    command: 'my-tool',
    description: 'Third-party tool',
    entry: 'bin/my-tool',
    permissions,
    execution: { args: [], env: {} },
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        url: 'https://github.com/someuser/my-tool/releases/download/v1/my-tool.tar.gz',
        sha256: '',
        format: 'tar.gz',
        executable: 'my-tool',
      },
    },
  });

  function mockToolRelease(version: string) {
    return (async () => {
      const buffer = await buildTarGz('my-tool', version);
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      requestSend.mockImplementation(async (url: string) => {
        if (url.includes('/releases/latest')) {
          return { url: `https://github.com/someuser/my-tool/releases/tag/v${version}` };
        }
        throw new Error(`unexpected Request.send: ${url}`);
      });
      requestFetch.mockImplementation(async (url: string) => {
        expect(url).toContain(`raw.githubusercontent.com/someuser/my-tool/v${version}/offckb-tool.json`);
        return { status: 200, ok: true, json: async () => ({ ...toolDescriptor(version), platforms: { [`${process.platform}-${process.arch}`]: { url: 'https://github.com/someuser/my-tool/releases/download/v1/my-tool.tar.gz', sha256: digest, format: 'tar.gz', executable: 'my-tool' } } }) };
      });
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(buffer));
      return { buffer, fetchSpy };
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

  it('requires explicit grants for a github descriptor that declares permissions', async () => {
    await mockToolRelease('0.1.0');
    const digest = crypto.createHash('sha256').update(await buildTarGz('my-tool', '0.1.0')).digest('hex');
    requestFetch.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        ...toolDescriptor('0.1.0', ['devnet-read']),
        platforms: {
          [`${process.platform}-${process.arch}`]: {
            url: 'https://github.com/someuser/my-tool/releases/download/v0.1.0/my-tool.tar.gz',
            sha256: digest,
            format: 'tar.gz',
            executable: 'my-tool',
          },
        },
      }),
    }));
    addTrustedSource('someuser/my-tool');

    await expect(installPlugin('github:someuser/my-tool', new Set(), {})).rejects.toThrow('--allow devnet-read');
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

  it('re-approving a revoked source via a same-version reinstall persists the approval', async () => {
    await mockToolRelease('0.1.0');
    // Install and approve, then revoke: the tool stays, the approval goes.
    await installPlugin('github:someuser/my-tool', new Set(), { trustSource: 'someuser/my-tool' });
    removeTrustedSource('someuser/my-tool');
    expect(listTrustedSources()).toEqual([]);

    // Idempotent reinstall with --trust-source is a success exit too; the
    // approval must persist there as well, not only on fresh installs.
    const { source } = await installPlugin('github:someuser/my-tool', new Set(), {
      trustSource: 'someuser/my-tool',
    });

    expect(source.resolved).toBe('github:someuser/my-tool#v0.1.0');
    expect(listTrustedSources()).toEqual(['someuser/my-tool']);
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

  it('falls back to probing the default branch when a repository has no releases', async () => {
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('/releases/latest')) throw new Error('this repository has no releases');
      throw new Error(`unexpected Request.send: ${url}`);
    });
    requestFetch.mockImplementation(async (url: string) => {
      expect(url).toContain('raw.githubusercontent.com/someuser/js-only-repo/HEAD/offckb-tool.json');
      return { status: 404, ok: false };
    });

    // npm-shaped JS plugin repos without releases must still reach the npm path.
    expect(await probeBinaryDescriptor('someuser/js-only-repo')).toBeNull();
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
