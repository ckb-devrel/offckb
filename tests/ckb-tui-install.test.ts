import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

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
};

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
    binaryPath = path.join(mockDirs.toolsRoot, process.platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui');
    mockVersion.current = 'v0.1.4';
    internals.binaryPath = null;
    realInstallSync = internals.installSync;
    installSpy = jest.fn();
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

    expect(() => CKBTui.ensureInstalled()).not.toThrow();
    expect(installSpy).toHaveBeenCalledTimes(1);
    // The stale binary must be removed before install so no platform-specific
    // rename-over-existing behavior can keep it in place.
    expect(fs.existsSync(binaryPath)).toBe(false);
  });

  it('falls back to presence-only detection for a release without a pinned binary digest', () => {
    mockVersion.current = 'v9.9.9';
    fs.writeFileSync(binaryPath, 'any content at all');

    expect(CKBTui.ensureInstalled()).toBe(binaryPath);
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('installs when no binary exists yet', () => {
    CKBTui.ensureInstalled();
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
});
