import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
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

import {
  CKBDebuggerInstaller,
  isVersionAtLeast,
  selectAsset,
  CkbDebuggerReleaseAsset,
} from '../src/tools/ckb-debugger-install';

const requestSend = Request.send as jest.Mock;

function asset(name: string): CkbDebuggerReleaseAsset {
  return { name, browserDownloadUrl: `https://example.com/${name}` };
}

function platformAssetName(): string {
  const p = process.platform;
  if (p === 'win32') {
    return 'ckb-debugger-win64.zip';
  }
  if (p === 'darwin') {
    return process.arch === 'arm64' ? 'ckb-debugger-macos-aarch64.zip' : 'ckb-debugger-macos-x86_64.zip';
  }
  return 'ckb-debugger-linux-x86_64.zip';
}

function platformBinaryName(): string {
  return process.platform === 'win32' ? 'ckb-debugger.exe' : 'ckb-debugger';
}

/** A runnable-looking fake binary payload embedded in the test zip archive. */
function fakeBinaryPayload(version: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho "ckb-debugger ${version}"\n`);
}

describe('selectAsset', () => {
  it('matches linux x86_64 assets on linux/x64', () => {
    const assets = [asset('ckb-debugger-macos-aarch64.tar.gz'), asset('ckb-debugger-linux-x86_64.tar.gz')];
    const picked = selectAsset(assets, 'linux', 'x64');
    expect(picked?.name).toBe('ckb-debugger-linux-x86_64.tar.gz');
  });

  it('matches macOS aarch64 assets on darwin/arm64', () => {
    const assets = [asset('ckb-debugger-win64.zip'), asset('ckb-debugger-macos-aarch64.tar.gz')];
    const picked = selectAsset(assets, 'darwin', 'arm64');
    expect(picked?.name).toBe('ckb-debugger-macos-aarch64.tar.gz');
  });

  it('matches windows assets on win32/x64', () => {
    const picked = selectAsset([asset('ckb-debugger-win64.zip')], 'win32', 'x64');
    expect(picked?.name).toBe('ckb-debugger-win64.zip');
  });

  it('prefers archive assets over bare executables', () => {
    const assets = [asset('ckb-debugger-linux-x86_64'), asset('ckb-debugger-linux-x86_64.tar.gz')];
    const picked = selectAsset(assets, 'linux', 'x64');
    expect(picked?.name).toBe('ckb-debugger-linux-x86_64.tar.gz');
  });

  it('returns null when no asset matches the platform', () => {
    expect(selectAsset([asset('ckb-debugger-win64.zip')], 'linux', 'x64')).toBeNull();
    expect(selectAsset([asset('ckb-debugger-linux-x86_64.tar.gz')], 'darwin', 'arm64')).toBeNull();
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

  function mockLatestRelease(assetName: string, buffer: Buffer, digest: string) {
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('releases/latest')) {
        return {
          json: async () => ({
            tag_name: 'v0.208.0',
            assets: [{ name: assetName, browser_download_url: `https://example.com/${assetName}`, digest }],
          }),
        };
      }
      return { arrayBuffer: async () => buffer };
    });
  }

  function buildZip(assetName: string, version: string): { name: string; buffer: Buffer } {
    const zip = new AdmZip();
    zip.addFile(platformBinaryName(), fakeBinaryPayload(version));
    return { name: assetName, buffer: zip.toBuffer() };
  }

  it('downloads, verifies and publishes the latest release binary', async () => {
    const { name, buffer } = buildZip(platformAssetName(), '0.208.0');
    mockLatestRelease(name, buffer, `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`);

    const result = await CKBDebuggerInstaller.install();

    expect(result.alreadyInstalled).toBe(false);
    expect(result.binaryPath).toBe(binaryPath);
    expect(fs.existsSync(binaryPath)).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 0.208.0"');
    expect(requestSend).toHaveBeenCalledTimes(2);
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
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'ckb-debugger 0.113.1\n', stderr: '' };
    });

    const { name, buffer } = buildZip(platformAssetName(), '0.208.0');
    mockLatestRelease(name, buffer, `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`);

    const result = await CKBDebuggerInstaller.install();

    expect(result.alreadyInstalled).toBe(false);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toContain('echo "ckb-debugger 0.208.0"');
  });

  it('fails closed when the downloaded checksum does not match', async () => {
    const { name, buffer } = buildZip(platformAssetName(), '0.208.0');
    mockLatestRelease(name, buffer, `sha256:${'0'.repeat(64)}`);

    await expect(CKBDebuggerInstaller.install()).rejects.toThrow('checksum mismatch');
    expect(fs.existsSync(binaryPath)).toBe(false);
  });

  it('throws when no release asset matches the platform', async () => {
    requestSend.mockImplementation(async (url: string) => {
      if (url.includes('releases/latest')) {
        return {
          json: async () => ({
            tag_name: 'v0.208.0',
            assets: [{ name: 'ckb-debugger-freebsd-x86_64.zip', browser_download_url: 'https://example.com/x.zip' }],
          }),
        };
      }
      throw new Error('should not download');
    });

    await expect(CKBDebuggerInstaller.install()).rejects.toThrow(/No ckb-debugger release asset matches/);
  });
});
