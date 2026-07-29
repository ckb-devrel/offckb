import { EventEmitter } from 'events';
import { startNode } from '../src/cmd/node';
import { Network } from '../src/type/base';

const mockSpawn = jest.fn();
const mockGetVersionFromBinary = jest.fn();
const mockInstallCKBBinary = jest.fn();
const mockInitChainIfNeeded = jest.fn();
const mockDevnetConfigHasTerminalRpc = jest.fn();
const mockWaitForNodeReady = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('../src/node/install', () => ({
  installCKBBinary: (...args: unknown[]) => mockInstallCKBBinary(...args),
  getVersionFromBinary: (...args: unknown[]) => mockGetVersionFromBinary(...args),
}));

jest.mock('../src/node/init-chain', () => ({
  ...jest.requireActual('../src/node/init-chain'),
  initChainIfNeeded: (...args: unknown[]) => mockInitChainIfNeeded(...args),
  devnetConfigHasTerminalRpc: (...args: unknown[]) => mockDevnetConfigHasTerminalRpc(...args),
}));

jest.mock('../src/tools/rpc-proxy', () => ({
  createRPCProxy: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../src/devnet/readiness', () => ({
  checkNodeReadiness: jest.fn().mockResolvedValue({ ready: false, rpcUrl: 'http://127.0.0.1:8114' }),
  waitForNodeReady: (...args: unknown[]) => mockWaitForNodeReady(...args),
}));

jest.mock('../src/devnet/fork', () => ({
  readForkState: jest.fn(() => null),
  markForkFirstRunComplete: jest.fn(),
}));

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    bins: { defaultCKBVersion: '0.207.0' },
    devnet: {
      configPath: '/tmp/offckb-devnet-config',
      dataPath: '/tmp/offckb-devnet-data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
    },
  }),
  getCKBBinaryPath: (version: string) => `/managed/ckb/${version}/ckb`,
}));

jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
    setJsonMode: jest.fn(),
  },
}));

import { logger } from '../src/util/logger';

// A minimal stand-in for a spawned ChildProcess: event emitter plus piped
// stdio emitters. `once('spawn')` fires on the next tick so waitForChildSpawn
// resolves without the test orchestrating timing.
function makeFakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    killed: boolean;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });
  const originalOnce = child.once.bind(child);
  child.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'spawn') process.nextTick(listener);
    return originalOnce(event, listener);
  }) as typeof child.once;
  return child;
}

describe('node devnet Terminal RPC version handling', () => {
  let ckbChild: ReturnType<typeof makeFakeChild>;
  let minerChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    jest.clearAllMocks();
    ckbChild = makeFakeChild(1111);
    minerChild = makeFakeChild(2222);
    mockSpawn.mockReset();
    mockSpawn.mockReturnValueOnce(ckbChild).mockReturnValueOnce(minerChild);
    mockWaitForNodeReady.mockResolvedValue({ ready: true, rpcUrl: 'http://127.0.0.1:8114', nodeTip: 0n });
    mockInstallCKBBinary.mockResolvedValue(undefined);
    mockInitChainIfNeeded.mockResolvedValue(undefined);
    mockDevnetConfigHasTerminalRpc.mockReturnValue(false);
    mockGetVersionFromBinary.mockReturnValue(null);
  });

  it('passes the managed version to chain init and starts normally', async () => {
    await startNode({ network: Network.devnet, version: '0.120.0' });

    expect(mockInstallCKBBinary).toHaveBeenCalledWith('0.120.0');
    expect(mockInitChainIfNeeded).toHaveBeenCalledWith({ ckbVersion: '0.120.0' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('predates the Terminal RPC module'));
  });

  it('uses the settings default version when none is given', async () => {
    await startNode({ network: Network.devnet });

    expect(mockInstallCKBBinary).toHaveBeenCalledWith('0.207.0');
    expect(mockInitChainIfNeeded).toHaveBeenCalledWith({ ckbVersion: '0.207.0' });
  });

  it('probes a custom --binary-path version and forwards it to chain init', async () => {
    mockGetVersionFromBinary.mockReturnValue('0.120.0');

    await startNode({ network: Network.devnet, binaryPath: '/custom/ckb' });

    expect(mockGetVersionFromBinary).toHaveBeenCalledWith('/custom/ckb');
    expect(mockInstallCKBBinary).not.toHaveBeenCalled();
    expect(mockInitChainIfNeeded).toHaveBeenCalledWith({ ckbVersion: '0.120.0' });
  });

  it('fails fast with an actionable error when the config has Terminal but the managed binary is too old', async () => {
    mockDevnetConfigHasTerminalRpc.mockReturnValue(true);

    await expect(startNode({ network: Network.devnet, version: '0.120.0' })).rejects.toThrow(
      /requires CKB >= 0\.205\.0; the selected binary is 0\.120\.0/,
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('fails fast when a probed custom binary is too old for the config', async () => {
    mockGetVersionFromBinary.mockReturnValue('0.200.0');
    mockDevnetConfigHasTerminalRpc.mockReturnValue(true);

    await expect(startNode({ network: Network.devnet, binaryPath: '/custom/ckb' })).rejects.toThrow(
      /remove "Terminal" from rpc\.modules/,
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does not fail fast for an unprobeable custom binary (unknown version assumes support)', async () => {
    mockGetVersionFromBinary.mockReturnValue(null);
    mockDevnetConfigHasTerminalRpc.mockReturnValue(true);

    await startNode({ network: Network.devnet, binaryPath: '/custom/ckb' });

    expect(mockInitChainIfNeeded).toHaveBeenCalledWith({ ckbVersion: null });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('allows a new-enough binary with a Terminal-enabled config', async () => {
    mockDevnetConfigHasTerminalRpc.mockReturnValue(true);

    await startNode({ network: Network.devnet, version: '0.207.0' });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('predates the Terminal RPC module'));
  });

  it('translates an "unknown variant `Terminal`" startup crash into an actionable error', async () => {
    mockWaitForNodeReady.mockImplementation(async () => {
      ckbChild.stderr.emit(
        'data',
        Buffer.from(
          'Error: TOML parse error: unknown variant `Terminal`, expected one of `Net`, `Pool`, `Miner`, `Chain`',
        ),
      );
      return { ready: false, error: 'CKB process exited' };
    });

    await expect(startNode({ network: Network.devnet, binaryPath: '/custom/ckb' })).rejects.toThrow(
      /The "Terminal" RPC module requires CKB >= 0\.205\.0; remove "Terminal" from rpc\.modules/,
    );
  });

  it('reports a plain startup failure when the stderr tail has no Terminal signature', async () => {
    mockWaitForNodeReady.mockImplementation(async () => {
      ckbChild.stderr.emit('data', Buffer.from('some unrelated panic'));
      return { ready: false, error: 'CKB process exited' };
    });

    await expect(startNode({ network: Network.devnet, binaryPath: '/custom/ckb' })).rejects.toThrow(
      /^CKB devnet failed to become ready: CKB process exited$/,
    );
  });
});
