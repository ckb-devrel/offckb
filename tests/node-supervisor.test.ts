import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
const mockProxyStart = jest.fn();
const mockProxyStop = jest.fn();
const mockMarkForkFirstRunComplete = jest.fn();
const mockCallJsonRpc = jest.fn();
let mockForkState: { source: 'mainnet'; firstRunPending: boolean; genesisHash: string } | null = null;

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
  readForkState: () => mockForkState,
  markForkFirstRunComplete: (...args: unknown[]) => mockMarkForkFirstRunComplete(...args),
}));
jest.mock('../src/util/json-rpc', () => ({ callJsonRpc: (...args: unknown[]) => mockCallJsonRpc(...args) }));
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
    mockForkState = null;
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

  it('does not start the proxy when CKB exits while the miner is starting', async () => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValueOnce(ckb).mockImplementationOnce(() => {
      process.nextTick(() => {
        ckb.emit('exit', 1, null);
        miner.emit('spawn');
      });
      return miner;
    });

    await expect(nodeDevnet({})).rejects.toThrow('exited while the miner was starting');
    expect(miner.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockProxyStart).not.toHaveBeenCalled();
  });

  it('records the source tip as the fork boundary before the miner starts', async () => {
    const genesisHash = '0x' + 'ab'.repeat(32);
    mockForkState = { source: 'mainnet', firstRunPending: true, genesisHash };
    mockCallJsonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'get_block_hash') return genesisHash;
      if (method === 'get_tip_block_number') return '0x64';
      throw new Error(method);
    });

    await nodeDevnet({});

    expect(mockMarkForkFirstRunComplete).toHaveBeenCalledWith('/tmp/offckb-devnet', '100');
    expect(mockProxyStart).toHaveBeenCalled();
  });
});
