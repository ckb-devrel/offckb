import fs from 'fs';
import { spawnSync, execFileSync } from 'child_process';
import { CKBDebuggerInstaller } from '../src/tools/ckb-debugger-install';
import { CKBDebugger } from '../src/tools/ckb-debugger';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFileSync: jest.fn(),
}));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));
jest.mock('../src/tools/ckb-debugger-install', () => ({
  CKBDebuggerInstaller: { getInstalledBinaryPath: jest.fn() },
}));

const mockSpawnSync = spawnSync as jest.Mock;
const mockExecFileSync = execFileSync as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockGetInstalledBinaryPath = CKBDebuggerInstaller.getInstalledBinaryPath as jest.Mock;

const GUARD = 'OFFCKB_DEBUGGER_GUARD';
const originalGuard = process.env[GUARD];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GUARD];
});

afterEach(() => {
  if (originalGuard === undefined) {
    delete process.env[GUARD];
  } else {
    process.env[GUARD] = originalGuard;
  }
});

describe('CKBDebugger', () => {
  it('runs the PATH binary when the PATH probe succeeds', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    mockGetInstalledBinaryPath.mockReturnValue('/managed/ckb-debugger');

    CKBDebugger.runWithArgs(['--version']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--version'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith('ckb-debugger', ['--version'], expect.anything());
    expect(mockGetInstalledBinaryPath).not.toHaveBeenCalled();
  });

  it('falls back to the managed binary when the PATH probe fails', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockGetInstalledBinaryPath.mockReturnValue('/managed/ckb-debugger');
    mockExistsSync.mockImplementation((p: string) => p === '/managed/ckb-debugger');

    CKBDebugger.runWithArgs(['--tx-file', 'a b.json']);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/managed/ckb-debugger',
      ['--tx-file', 'a b.json'],
      expect.anything(),
    );
  });

  it('throws a clear error when neither PATH nor the managed binary exists', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockGetInstalledBinaryPath.mockReturnValue('/managed/ckb-debugger');
    mockExistsSync.mockReturnValue(false);

    expect(() => CKBDebugger.runWithArgs(['--version'])).toThrow(
      /ckb-debugger is not installed. Install it once with: offckb install ckb-debugger/,
    );
  });

  it('does not probe PATH again when the recursion guard env var is set', () => {
    process.env[GUARD] = '1';
    mockGetInstalledBinaryPath.mockReturnValue('/managed/ckb-debugger');
    mockExistsSync.mockReturnValue(true);

    CKBDebugger.runWithArgs(['--version']);

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith('/managed/ckb-debugger', ['--version'], expect.anything());
  });

  it('sets the recursion guard env var on the binary it spawns', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    CKBDebugger.runWithArgs(['--version']);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--version'],
      expect.objectContaining({ env: expect.objectContaining({ [GUARD]: '1' }) }),
    );
  });
});

describe('CKBDebugger.runRaw', () => {
  it('strips quotes from a quoted tx-file path instead of passing them to argv', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    CKBDebugger.runRaw('--tx-file "/tmp/offckb/devnet/full-transactions/0xabc.json" --cell-index 0');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--tx-file', '/tmp/offckb/devnet/full-transactions/0xabc.json', '--cell-index', '0'],
      expect.anything(),
    );
  });

  it('keeps a quoted path containing spaces as a single argv element', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    CKBDebugger.runRaw('--tx-file "/path/with space/tx.json" --bin "/my bin/ckb"');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--tx-file', '/path/with space/tx.json', '--bin', '/my bin/ckb'],
      expect.anything(),
    );
  });

  it('unescapes an embedded quote so the path stays a single argv element', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    CKBDebugger.runRaw('--tx-file "/path/with\\"quote/tx.json"');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--tx-file', '/path/with"quote/tx.json'],
      expect.anything(),
    );
  });

  it('passes unquoted arguments through unchanged', () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    CKBDebugger.runRaw('--tx-file /unquoted/path.json --cell-type input');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--tx-file', '/unquoted/path.json', '--cell-type', 'input'],
      expect.anything(),
    );
  });
});
