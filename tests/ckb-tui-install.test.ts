import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: jest.fn(),
}));
jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const mockVersion = { current: 'v0.1.4' };
const mockDirs = { dataRoot: '', toolsRoot: '' };

jest.mock('../src/cfg/setting', () => ({
  get dataPath() {
    return mockDirs.dataRoot;
  },
  readSettings: () => ({
    tools: { rootFolder: mockDirs.toolsRoot, ckbTui: { version: mockVersion.current } },
  }),
}));

import { CKBTui } from '../src/tools/ckb-tui';

type CKBTuiInternals = {
  binaryPath: string | null;
  installSync: () => void;
  installedBinaryMatches: (binaryPath: string) => boolean;
  publishExtractedBinary: (extractedBinary: string, binaryPath: string) => void;
};

const binaryName = () => (process.platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui');

// Content the successful install spy publishes, standing in for the verified
// binary the real installSync would atomically rename into place.
const REPLACED_BINARY = 'verified replacement ckb-tui';

describe('ckb-tui installed-binary verification', () => {
  const internals = CKBTui as unknown as CKBTuiInternals;
  let realInstallSync: () => void;
  let installSpy: jest.Mock;
  let binaryPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDirs.dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-tui-data-'));
    mockDirs.toolsRoot = path.join(mockDirs.dataRoot, 'tools');
    fs.mkdirSync(mockDirs.toolsRoot, { recursive: true });
    binaryPath = path.join(mockDirs.toolsRoot, binaryName());
    mockVersion.current = 'v0.1.4';
    internals.binaryPath = null;
    realInstallSync = internals.installSync;
    // Mimic a successful installSync: publish a real regular replacement file
    // at the install path (setting aside a directory that occupies it, like
    // the real publish step does). Tests that need a failing install override
    // this with a no-publish mockImplementation that throws.
    installSpy = jest.fn().mockImplementation(() => {
      try {
        if (fs.lstatSync(binaryPath).isDirectory()) {
          fs.renameSync(binaryPath, `${binaryPath}.set-aside`);
        }
      } catch {
        // Nothing at the install path yet.
      }
      fs.writeFileSync(binaryPath, REPLACED_BINARY);
      internals.binaryPath = binaryPath;
    });
    internals.installSync = installSpy;
  });

  afterEach(() => {
    internals.installSync = realInstallSync;
    internals.binaryPath = null;
    fs.rmSync(mockDirs.dataRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const assetName = () => {
    if (process.platform === 'darwin') return 'ckb-tui-with-node-macos-aarch64.tar.gz';
    if (process.platform === 'win32') return 'ckb-tui-with-node-windows-amd64.zip';
    return 'ckb-tui-with-node-linux-amd64.tar.gz';
  };

  // The pinned binary digest for the current platform's v0.1.4 asset, kept in
  // sync with KNOWN_BINARY_SHA256 in src/tools/ckb-tui.ts.
  const pinnedDigest = () =>
    (
      ({
        'ckb-tui-with-node-linux-amd64.tar.gz': 'e2c31db99e81ea6ae0455796464a671c10bf8fe74615c40b995c34ff57630b43',
        'ckb-tui-with-node-macos-aarch64.tar.gz': 'a9748cf1581568cf7409193d5cb851ea956a82a84fd69c08513fee351a8ad7fc',
        'ckb-tui-with-node-windows-amd64.zip': '2ed73cd9095b2f9b947377736e8013985f48a8c1e696a3dd78033af658aab612',
      }) as Record<string, string>
    )[assetName()];

  it('keeps an existing binary whose digest matches the configured release', () => {
    fs.writeFileSync(binaryPath, 'installed ckb-tui');
    jest.spyOn(crypto, 'createHash').mockReturnValue({
      update: () => ({ digest: () => pinnedDigest() }),
    } as unknown as crypto.Hash);

    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('reinstalls when the on-disk binary does not match the pinned digest', () => {
    fs.writeFileSync(binaryPath, 'stale ckb-tui from an older release');
    installSpy.mockImplementation(() => {
      // The stale binary is NOT deleted up front: it is still in place when
      // the reinstall begins and is only replaced once the verified new
      // binary is ready to publish.
      expect(fs.readFileSync(binaryPath, 'utf8')).toBe('stale ckb-tui from an older release');
      fs.writeFileSync(binaryPath, REPLACED_BINARY);
      internals.binaryPath = binaryPath;
    });

    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(fs.statSync(binaryPath).isFile()).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(REPLACED_BINARY);
  });

  it('keeps the existing binary when the reinstall fails', () => {
    fs.writeFileSync(binaryPath, 'stale ckb-tui from an older release');
    installSpy.mockImplementation(() => {
      internals.binaryPath = null;
      throw new Error('network down');
    });

    expect(() => CKBTui.ensureInstalled()).toThrow('network down');
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe('stale ckb-tui from an older release');
  });

  it('treats a non-regular path at the binary location as a mismatch and reinstalls', () => {
    fs.mkdirSync(binaryPath);

    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(fs.statSync(binaryPath).isFile()).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(REPLACED_BINARY);
  });

  it('falls back to presence-only detection for a release without a pinned binary digest', () => {
    mockVersion.current = 'v9.9.9';
    fs.writeFileSync(binaryPath, 'any content at all');

    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('installs when no binary exists yet', () => {
    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(fs.statSync(binaryPath).isFile()).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(REPLACED_BINARY);
  });

  const itPosix = process.platform === 'win32' ? it.skip : it;
  const itPosixNonRoot = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;

  itPosix('does not block on a FIFO at the binary location', () => {
    // Pinned digest path: the digest read must not open a FIFO, whose
    // blocking read would hang ensureInstalled indefinitely. readFileSync is
    // mocked to throw so a regression fails fast instead of hanging the Jest
    // worker synchronously (a timer-based timeout cannot fire mid-read).
    execFileSync('mkfifo', [binaryPath]);
    const readFileSync = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('A FIFO must not be read');
    });

    expect(internals.installedBinaryMatches(binaryPath)).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  itPosixNonRoot('treats an unreadable binary as a mismatch', () => {
    mockVersion.current = 'v9.9.9'; // Unpinned: presence alone must not suffice.
    fs.writeFileSync(binaryPath, 'unreadable ckb-tui', { mode: 0o000 });

    expect(internals.installedBinaryMatches(binaryPath)).toBe(false);
  });
});

describe('ckb-tui binary publishing', () => {
  const internals = CKBTui as unknown as CKBTuiInternals;
  let binDir: string;
  let binaryPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-tui-publish-'));
    binaryPath = path.join(binDir, binaryName());
  });

  afterEach(() => fs.rmSync(binDir, { recursive: true, force: true }));

  it('replaces an existing file in place', () => {
    fs.writeFileSync(binaryPath, 'old binary');
    const extracted = path.join(binDir, 'extracted-ckb-tui');
    fs.writeFileSync(extracted, REPLACED_BINARY);

    internals.publishExtractedBinary(extracted, binaryPath);

    expect(fs.statSync(binaryPath).isFile()).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(REPLACED_BINARY);
  });

  it('replaces a directory occupying the install path without deleting its contents', () => {
    fs.mkdirSync(binaryPath);
    fs.writeFileSync(path.join(binaryPath, 'user-file.txt'), 'user data');
    const extracted = path.join(binDir, 'extracted-ckb-tui');
    fs.writeFileSync(extracted, REPLACED_BINARY);

    internals.publishExtractedBinary(extracted, binaryPath);

    expect(fs.statSync(binaryPath).isFile()).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(REPLACED_BINARY);
    // The directory was set aside with a plain rename, not deleted.
    const backups = fs.readdirSync(binDir).filter((name) => name.startsWith(`${binaryName()}.backup-`));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(binDir, backups[0], 'user-file.txt'), 'utf8')).toBe('user data');
  });

  it('restores the original directory when publishing fails', () => {
    fs.mkdirSync(binaryPath);
    fs.writeFileSync(path.join(binaryPath, 'user-file.txt'), 'user data');

    expect(() => internals.publishExtractedBinary(path.join(binDir, 'missing-binary'), binaryPath)).toThrow();

    expect(fs.statSync(binaryPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(binaryPath, 'user-file.txt'), 'utf8')).toBe('user data');
    // No set-aside backup is left behind after the successful restore.
    const backups = fs.readdirSync(binDir).filter((name) => name.startsWith(`${binaryName()}.backup-`));
    expect(backups).toHaveLength(0);
  });
});
