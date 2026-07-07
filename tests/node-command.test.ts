import { startNode, stopNode } from '../src/cmd/node';
import { Network } from '../src/type/base';

const mockSpawn = jest.fn();
const mockOpenSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockUnlinkSync = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
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

describe('node command daemon mode', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.clearAllMocks();
    process.argv = ['node', '/path/to/offckb', 'node', '--daemon'];
    mockOpenSync.mockReturnValue(3);
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: jest.fn(),
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('spawns a detached child process without the --daemon flag', () => {
    startNode({ network: Network.devnet, daemon: true });

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/offckb-devnet-data/logs', { recursive: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/path/to/offckb', 'node'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 3, 3],
        env: expect.objectContaining({ OFFCKB_DAEMON_CHILD: '1' }),
      }),
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/offckb-devnet-data/logs/daemon.pid', '12345');
    expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon started with PID 12345.');
  });

  it('warns and ignores daemon flag for non-devnet networks', () => {
    startNode({ network: Network.testnet, daemon: true });

    expect(logger.warn).toHaveBeenCalledWith('Daemon mode is only supported for devnet. The daemon flag will be ignored.');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('node command stop', () => {
  let killSpy: jest.SpyInstance;
  let processAlive = true;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    processAlive = true;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('12345');
    killSpy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          throw new Error('ESRCH');
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
    mockExistsSync.mockReturnValue(false);
    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No daemon PID file found'));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('errors when the PID file contains an invalid PID', async () => {
    mockReadFileSync.mockReturnValue('not-a-number');
    await stopNode();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid PID'));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('removes the PID file when the daemon is not running', async () => {
    processAlive = false;
    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/offckb-devnet-data/logs/daemon.pid');
  });

  it('stops the daemon gracefully with SIGTERM', async () => {
    await stopNode();
    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/offckb-devnet-data/logs/daemon.pid');
    expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon stopped.');
  });

  it('falls back to SIGKILL when the daemon does not exit gracefully', async () => {
    // Simulate a process that ignores SIGTERM
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      return true;
    });

    const stopPromise = stopNode();
    jest.advanceTimersByTime(5000);
    await stopPromise;

    expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/offckb-devnet-data/logs/daemon.pid');
  });
});
