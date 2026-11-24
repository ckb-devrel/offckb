import fs from 'fs';
import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { nativeBinaryFileName } from '../src/plugins/manifest';
import { getNativeBinaryPath } from '../src/plugins/store';
import { CKBDebugger } from '../src/tools/ckb-debugger';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFileSync: jest.fn(),
}));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));
jest.mock('../src/plugins/store', () => ({
  getNativeBinaryPath: jest.fn(),
}));
jest.mock('../src/plugins/install', () => ({ installPlugin: jest.fn() }));
jest.mock('../src/plugins/shims', () => ({ ensureCommandShim: jest.fn() }));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({ tools: { rootFolder: '/legacy/tools', ckbDebugger: { minVersion: '0.200.0' } } }),
}));

const mockSpawnSync = spawnSync as jest.Mock;
const mockExecFileSync = execFileSync as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockGetNativeBinaryPath = getNativeBinaryPath as jest.Mock;

const LEGACY_BINARY = path.join('/legacy/tools/ckb-debugger', nativeBinaryFileName('ckb-debugger'));

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
    mockGetNativeBinaryPath.mockReturnValue('/native/ckb-debugger');

    CKBDebugger.runWithArgs(['--version']);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'ckb-debugger',
      ['--version'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith('ckb-debugger', ['--version'], expect.anything());
    expect(mockGetNativeBinaryPath).not.toHaveBeenCalled();
  });

  it('falls back to the registered plugin binary when the PATH probe fails', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockGetNativeBinaryPath.mockReturnValue('/native/ckb-debugger');
    mockExistsSync.mockImplementation((p: string) => p === '/native/ckb-debugger');

    CKBDebugger.runWithArgs(['--tx-file', 'a b.json']);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/native/ckb-debugger',
      ['--tx-file', 'a b.json'],
      expect.anything(),
    );
  });

  it('falls back to a leftover pre-plugin binary under tools.rootFolder', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockGetNativeBinaryPath.mockReturnValue(null);
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_BINARY);

    CKBDebugger.runWithArgs(['--version']);

    expect(mockExecFileSync).toHaveBeenCalledWith(LEGACY_BINARY, ['--version'], expect.anything());
  });

  it('throws a clear error when no install location has the binary', () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockGetNativeBinaryPath.mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);

    expect(() => CKBDebugger.runWithArgs(['--version'])).toThrow(
      /ckb-debugger is not installed. Install it once with: offckb install ckb-debugger/,
    );
  });

  it('does not probe PATH again when the recursion guard env var is set', () => {
    process.env[GUARD] = '1';
    mockGetNativeBinaryPath.mockReturnValue('/native/ckb-debugger');
    mockExistsSync.mockReturnValue(true);

    CKBDebugger.runWithArgs(['--version']);

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith('/native/ckb-debugger', ['--version'], expect.anything());
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

describe('CKBDebugger.installCKBDebuggerBinary', () => {
  // The lenient minVersion short-circuit belongs to the `offckb create` flow:
  // it must stay local-only and never reach the plugin installer.
  const installPluginMock = () =>
    jest.requireMock('../src/plugins/install').installPlugin as jest.Mock;

  it('short-circuits locally when the installed binary satisfies the pinned minimum', async () => {
    mockGetNativeBinaryPath.mockReturnValue('/native/ckb-debugger');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ckb-debugger 1.1.2\n' });

    const result = await CKBDebugger.installCKBDebuggerBinary();

    expect(installPluginMock()).not.toHaveBeenCalled();
    expect(result).toMatchObject({ binaryPath: '/native/ckb-debugger', version: '1.1.2', alreadyInstalled: true });
  });

  it('delegates to the plugin installer when the installed binary is below the minimum', async () => {
    mockGetNativeBinaryPath.mockReturnValue('/native/ckb-debugger');
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ckb-debugger 0.100.0\n' });
    installPluginMock().mockResolvedValue({ plugin: {}, source: {} });

    await CKBDebugger.installCKBDebuggerBinary(new Set(['help']));

    expect(installPluginMock()).toHaveBeenCalledWith('ckb-debugger', expect.any(Set), {});
  });

  it('delegates to the plugin installer when nothing is installed', async () => {
    mockGetNativeBinaryPath.mockReturnValue(null);
    installPluginMock().mockResolvedValue({ plugin: {}, source: {} });

    await CKBDebugger.installCKBDebuggerBinary();

    expect(installPluginMock()).toHaveBeenCalledWith('ckb-debugger', new Set(), {});
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
