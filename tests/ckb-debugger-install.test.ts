import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as tar from 'tar';
import { Request } from '../src/util/request';

const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));
jest.mock('../src/util/request', () => ({
  Request: { send: jest.fn() },
}));
jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockDirs = { dataRoot: '', toolsRoot: '' };
const mockMinVersion = { current: '0.200.0' };

jest.mock('../src/cfg/setting', () => ({
  get dataPath() {
    return mockDirs.dataRoot;
  },
  readSettings: () => ({
    tools: {
      rootFolder: mockDirs.toolsRoot,
      ckbDebugger: { minVersion: mockMinVersion.current },
    },
  }),
}));

import { CKBDebuggerInstaller, isVersionAtLeast, getAssetTarget } from '../src/tools/ckb-debugger-install';

const requestSend = Request.send as jest.Mock;

function platformTarget(): string {
  const p = process.platform;
  if (p === 'win32') return 'x86_64-pc-windows-msvc';
  if (p === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return 'x86_64-unknown-linux-gnu';
}

function platformBinaryName(): string {
  return process.platform === 'win32' ? 'ckb-debugger.exe' : 'ckb-debugger';
}

function fakeBinaryPayload(version: string): string {
  return `#!/bin/sh\necho "ckb-debugger ${version}"\n`;
}

describe('getAssetTarget', () => {
  it('maps known platform/arch combinations to upstream asset targets', () => {
    expect(getAssetTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(getAssetTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(getAssetTarget('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(getAssetTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(getAssetTarget('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
  });

  it('returns null for unsupported platforms/architectures', () => {
    expect(getAssetTarget('linux', 'ia32')).toBeNull();
    expect(getAssetTarget('win32', 'arm64')).toBeNull();
    expect(getAssetTarget('freebsd', 'x64')).toBeNull();
  });
});

describe('isVersionAtLeast', () => {
  it('compares versions numerically, not lexicographically', () => {
    expect(isVersionAtLeast('0.113.1', '0.200.0')).toBe(false);
    expect(isVersionAtLeast('0.200.0', '0.200.0')).toBe(true);
    expect(isVersionAtLeast('0.208.0', '0.200.0')).toBe(true);
    expect(isVersionAtLeast('0.9.0', '0.10.0')).toBe(false);
    expect(isVersionAtLeast('0.10.0', '0.9.0')).toBe(true);
  });

  it('returns false for unparseable versions', () => {
    expect(isVersionAtLeast('unknown', '0.200.0')).toBe(false);
  });
});

describe('CKBDebuggerInstaller', () => {
  let root: string;
  let binaryPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-debugger-test-'));
    mockDirs.dataRoot = root;
    mockDirs.toolsRoot = path.join(root, 'tools');
    binaryPath = path.join(mockDirs.toolsRoot, 'ckb-debugger', platformBinaryName());
    mockMinVersion.current = '0.200.0';
    // The offckb binary is not on PATH in the test environment: the PATH-shim
    // step is skipped with a warning instead of touching the host.
    mockSpawnSync.mockImplementation((cmd: string) =>
      cmd === 'which' || cmd === 'where'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function buildTarGz(version: string): Promise<Buffer> {
    // Use the cross-platform `tar` npm package (not the system tar binary):
    // on Windows, GNU tar misreads the "C:\" drive prefix in temp paths as a
    // remote host and fails, which breaks test-fixture creation there.
    return (async () => {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-debugger-stage-'));
      try {
        fs.writeFileSync(path.join(stage, platformBinaryName()), fakeBinaryPayload(version));
        const archivePath = path.join(stage, 'archive.tar.gz');
        await tar.c({ gzip: true, file: archivePath, cwd: stage }, [platformBinaryName()]);
        return fs.readFileSync(archivePath);
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    })();
  }

  function mockRelease(version: string, buffer: Buffer) {
    const tag = `v${version}`;
    const target = platformTarget();
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return {
          url: `https://github.com/nervosnetwork/ckb-standalone-debugger/releases/tag/${tag}`,
        };
      }
      if (url.endsWith('-sha256.txt')) {
        const digest = crypto.createHash('sha256').update(buffer).digest('hex');
        return { text: async () => `${digest}  ckb-debugger_${tag}_${target}.tar.gz` };
      }
      return { arrayBuffer: async () => buffer };
    });
  }

  it('downloads, verifies and publishes the latest release binary', async () => {
    const buffer = await buildTarGz('0.208.0');
    mockRelease('0.208.0', buffer);

    const result = await CKBDebuggerInstaller.install();

    expect(result.alreadyInstalled).toBe(false);
    expect(result.binaryPath).toBe(binaryPath);
    expect(fs.existsSync(binaryPath)).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 0.208.0"');
    expect(requestSend).toHaveBeenCalledTimes(3); // latest redirect + archive + sha256.txt
  });

  it('skips the download when a valid binary is already installed', async () => {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, fakeBinaryPayload('0.208.0'));
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'ckb-debugger 0.208.0\n', stderr: '' };
    });

    const result = await CKBDebuggerInstaller.install();

    expect(result.alreadyInstalled).toBe(true);
    expect(result.version).toBe('0.208.0');
    expect(requestSend).not.toHaveBeenCalled();
  });

  it('reinstalls when the installed binary is older than the required minimum', async () => {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, fakeBinaryPayload('0.113.1'));
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === binaryPath) {
        return { status: 0, stdout: 'ckb-debugger 0.113.1\n', stderr: '' };
      }
      return jest.requireActual('child_process').spawnSync(cmd, args, { stdio: 'ignore' });
    });

    const buffer = await buildTarGz('0.208.0');
    mockRelease('0.208.0', buffer);

    const result = await CKBDebuggerInstaller.install();

    expect(result.alreadyInstalled).toBe(false);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 0.208.0"');
  });

  it('fails closed when the downloaded checksum does not match', async () => {
    const buffer = await buildTarGz('0.208.0');
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return {
          url: 'https://github.com/nervosnetwork/ckb-standalone-debugger/releases/tag/v0.208.0',
        };
      }
      if (url.endsWith('-sha256.txt')) {
        return { text: async () => `${'0'.repeat(64)}  archive.tar.gz` };
      }
      return { arrayBuffer: async () => buffer };
    });

    await expect(CKBDebuggerInstaller.install()).rejects.toThrow('checksum mismatch');
    expect(fs.existsSync(binaryPath)).toBe(false);
  });

  it('throws when the platform has no prebuilt asset', async () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    try {
      await expect(CKBDebuggerInstaller.install()).rejects.toThrow(/no prebuilt binary/);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
    }
  });

  it('throws when the latest release tag cannot be resolved', async () => {
    requestSend.mockImplementation(async () => ({ url: 'https://github.com/somewhere/else' }));
    await expect(CKBDebuggerInstaller.install()).rejects.toThrow(/Could not resolve the latest/);
  });
});
