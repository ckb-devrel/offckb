import { startNode } from '../src/cmd/node';
import { Network } from '../src/type/base';

const mockSpawn = jest.fn();
const mockOpenSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
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
