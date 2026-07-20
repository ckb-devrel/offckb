import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
const mockProxyStart = jest.fn();
const mockProxyStop = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
jest.mock('../src/node/install', () => ({ installCKBBinary: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/node/init-chain', () => ({ initChainIfNeeded: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    bins: { defaultCKBVersion: '0.207.0' },
    devnet: {
      configPath: '/tmp/offckb-devnet',
      dataPath: '/tmp/offckb-devnet/data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
    },
  }),
  getCKBBinaryPath: () => '/tmp/ckb',
}));
jest.mock('../src/devnet/fork', () => ({
  readForkState: jest.fn().mockReturnValue(null),
  markForkFirstRunComplete: jest.fn(),
}));
jest.mock('../src/devnet/readiness', () => ({
  checkNodeReadiness: jest.fn(),
  waitForNodeReady: jest.fn().mockResolvedValue({ ready: true, rpcUrl: 'http://127.0.0.1:8114' }),
}));
jest.mock('../src/tools/rpc-proxy', () => ({
  createRPCProxy: () => ({ start: mockProxyStart, stop: mockProxyStop }),
}));
jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    result: jest.fn(),
  },
}));

import { nodeDevnet } from '../src/cmd/node';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = jest.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

describe('foreground devnet supervisor', () => {
  const originalExitCode = process.exitCode;
  let ckb: FakeChild;
  let miner: FakeChild;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    ckb = new FakeChild();
    miner = new FakeChild();
    mockSpawn.mockReturnValueOnce(ckb).mockImplementationOnce(() => {
      process.nextTick(() => miner.emit('spawn'));
      return miner;
    });
  });

  afterAll(() => {
    process.exitCode = originalExitCode;
  });

  it('stops miner and proxy when CKB exits', async () => {
    await nodeDevnet({});
    ckb.emit('exit', 2, null);
    expect(miner.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockProxyStop).toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('stops CKB and proxy when the miner exits', async () => {
    await nodeDevnet({});
    miner.emit('exit', 1, null);
    expect(ckb.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockProxyStop).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
