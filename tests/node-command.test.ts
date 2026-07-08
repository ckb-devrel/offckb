import { startNode, stopNode } from '../src/cmd/node';
import { Network } from '../src/type/base';
import * as path from 'path';

const mockSpawn = jest.fn();
const mockExec = jest.fn();
const mockOpenSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockStatSync = jest.fn();
const mockCloseSync = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
}));

jest.mock('../src/tools/rpc-proxy', () => ({
  createRPCProxy: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: {
      configPath: '/tmp/offckb-devnet-config',
      dataPath: '/tmp/offckb-devnet-data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
    },
    testnet: {
      rpcUrl: 'https://testnet.ckb.dev',
      rpcProxyPort: 38114,
    },
    mainnet: {
      rpcUrl: 'https://mainnet.ckb.dev',
      rpcProxyPort: 48114,
    },
  }),
}));

jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setJsonMode: jest.fn(),
  },
}));

import { logger } from '../src/util/logger';

const dataPath = '/tmp/offckb-devnet-data';
const logDir = path.join(dataPath, 'logs');
const pidFile = path.join(logDir, 'daemon.pid');
const logFile = path.join(logDir, 'daemon.log');

function mockDaemonCommandLine(scriptPath: string) {
  mockExec.mockImplementation((cmd: string, callback: (err: Error | null, stdout?: string) => void) => {
    if (cmd.startsWith('ps ') || cmd.startsWith('wmic ')) {
      callback(null, `/usr/bin/node ${scriptPath} node`);
      return undefined as unknown as ReturnType<typeof mockExec>;
    }
    callback(null, '');
    return undefined as unknown as ReturnType<typeof mockExec>;
  });
}

describe('node command daemon mode', () => {
  const originalArgv = process.argv;
  let killSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReset();
    process.argv = ['node', '/path/to/offckb', 'node', '--daemon'];
    mockOpenSync.mockReturnValue(3);
    mockStatSync.mockReturnValue({ isFile: () => true });
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: jest.fn(),
      on: jest.fn(),
    });
    killSpy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        // By default pretend the PID from a PID file is alive; individual tests override this.
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    killSpy.mockRestore();
  });

  it('spawns a detached child process without the --daemon flag', () => {
    startNode({ network: Network.devnet, daemon: true });

    expect(mockMkdirSync).toHaveBeenCalledWith(logDir, { recursive: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/path/to/offckb', 'node'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 3, 3],
        env: expect.objectContaining({ OFFCKB_DAEMON_CHILD: '1' }),
      }),
    );

    const writtenMetadata = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(writtenMetadata.pid).toBe(12345);
    expect(writtenMetadata.scriptPath).toBe('/path/to/offckb');
    expect(writtenMetadata.startedAt).toBeDefined();

    expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon started with PID 12345.');
  });

  it('warns and ignores daemon flag for non-devnet networks', () => {
    startNode({ network: Network.testnet, daemon: true });

    expect(logger.warn).toHaveBeenCalledWith(
      'Daemon mode is only supported for devnet. The daemon flag will be ignored.',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses to start when a daemon is already running', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 9999, scriptPath: '/path/to/offckb', startedAt: new Date().toISOString() }),
    );

    startNode({ network: Network.devnet, daemon: true });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('cleans up a stale PID file and starts a new daemon', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 9999, scriptPath: '/path/to/offckb', startedAt: new Date().toISOString() }),
    );
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    startNode({ network: Network.devnet, daemon: true });

    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('errors and cleans up when spawn fails synchronously', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn error');
    });

    startNode({ network: Network.devnet, daemon: true });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to spawn daemon process'),
      expect.any(Error),
    );
    expect(mockCloseSync).toHaveBeenCalledWith(3);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('errors when the spawned child has no PID', () => {
    mockSpawn.mockReturnValue({
      pid: undefined,
      unref: jest.fn(),
      on: jest.fn(),
    });

    startNode({ network: Network.devnet, daemon: true });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no PID returned'));
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('handles backward-compatible plain PID files', () => {
    mockReadFileSync.mockReturnValue('9999');
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    startNode({ network: Network.devnet, daemon: true });

    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe('node command stop', () => {
  let killSpy: jest.SpyInstance;
  let processAlive = true;
  const scriptPath = '/path/to/offckb';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    processAlive = true;
    mockExec.mockReset();
    mockStatSync.mockReturnValue({ isFile: () => true });
    mockReadFileSync.mockReturnValue(JSON.stringify({ pid: 12345, scriptPath, startedAt: new Date().toISOString() }));
    mockDaemonCommandLine(scriptPath);

    killSpy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        processAlive = false;
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    killSpy.mockRestore();
    jest.useRealTimers();
  });

  it('warns when no PID file exists', async () => {
    mockReadFileSync.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No daemon PID file found'));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('errors when the PID file contains an invalid PID', async () => {
    mockReadFileSync.mockReturnValue('not-a-number');
    await stopNode();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid PID'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('removes the PID file when the daemon is not running', async () => {
    processAlive = false;
    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('stops the daemon gracefully with SIGTERM', async () => {
    await stopNode();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon stopped.');
  });

  it('falls back to SIGKILL when the daemon does not exit gracefully', async () => {
    // Simulate a process that ignores SIGTERM but dies on SIGKILL.
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      if (signal === 'SIGKILL') {
        processAlive = false;
      }
      return true;
    });

    const stopPromise = stopNode();
    await jest.advanceTimersByTimeAsync(5000);
    await stopPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('refuses to kill a process that does not look like the daemon', async () => {
    mockExec.mockImplementation((cmd: string, callback: (err: Error | null, stdout?: string) => void) => {
      callback(null, '/usr/bin/some-other-process');
      return undefined as unknown as ReturnType<typeof mockExec>;
    });

    await stopNode();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('does not appear to be the offckb daemon'));
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('cleans up the PID file when SIGTERM fails with an unknown error', async () => {
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    await stopNode();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('cleans up the PID file when the process disappears between alive-check and SIGTERM', async () => {
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    await stopNode();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });
});
