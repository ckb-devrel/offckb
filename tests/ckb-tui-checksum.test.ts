import fs from 'fs';
import os from 'os';
import path from 'path';

const mockSpawnSync = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));
jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { CKBTui } from '../src/tools/ckb-tui';

describe('ckb-tui checksum policy', () => {
  let root: string;
  let archive: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-tui-checksum-'));
    archive = path.join(root, 'asset.tar.gz');
    fs.writeFileSync(archive, 'not the pinned release');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('enforces the pinned digest for the default release without a network fallback', () => {
    expect(() =>
      (CKBTui as unknown as { verifyChecksum: (...args: string[]) => void }).verifyChecksum(
        'v0.1.3',
        'ckb-tui-with-node-macos-aarch64.tar.gz',
        archive,
      ),
    ).toThrow('checksum mismatch');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('fails closed for an unpinned release without trusting its release manifest', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(() =>
      (CKBTui as unknown as { verifyChecksum: (...args: string[]) => void }).verifyChecksum(
        'v9.9.9',
        'ckb-tui-with-node-macos-aarch64.tar.gz',
        archive,
      ),
    ).toThrow('Refusing to install an unverified binary');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
