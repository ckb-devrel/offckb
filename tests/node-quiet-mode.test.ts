import { EventEmitter } from 'events';

const mockSpawn = jest.fn();
const mockProxyStart = jest.fn();
const mockProxyStop = jest.fn();
const mockSubscribe = jest.fn();
const mockTcpListenAddress = jest.fn();
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();

// The stale-miner reaper lists real OS processes (PowerShell CIM on Windows,
// which alone can take seconds); it has its own tests, so keep it out of
// these command-flow unit tests.
jest.mock('../src/devnet/stale-miner', () => ({
  ...jest.requireActual('../src/devnet/stale-miner'),
  reapStaleMiners: jest.fn().mockResolvedValue([]),
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
jest.mock('../src/node/install', () => ({ installCKBBinary: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/node/init-chain', () => ({
  initChainIfNeeded: jest.fn().mockResolvedValue(undefined),
  supportsTerminalRpcModule: () => true,
  devnetConfigHasTerminalRpc: () => false,
}));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    bins: { defaultCKBVersion: '0.207.0' },
    devnet: {
      configPath: '/tmp/offckb-devnet',
      dataPath: '/tmp/offckb-devnet/data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
      transactionsPath: '/tmp/offckb-devnet/transactions',
    },
  }),
  getCKBBinaryPath: () => '/tmp/ckb',
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => null }));
jest.mock('../src/devnet/readiness', () => ({
  checkNodeReadiness: jest.fn(),
  waitForNodeReady: jest.fn().mockResolvedValue({ ready: true, rpcUrl: 'http://127.0.0.1:8114' }),
}));
jest.mock('../src/tools/rpc-proxy', () => ({
  createRPCProxy: () => ({ start: mockProxyStart, stop: mockProxyStop }),
}));
jest.mock('../src/devnet/log-subscription', () => ({
  devnetTcpListenAddress: (...args: unknown[]) => mockTcpListenAddress(...args),
  subscribeToNodeLogs: (...args: unknown[]) => mockSubscribe(...args),
}));
jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: (...args: unknown[]) => loggerInfo(...args),
    warn: (...args: unknown[]) => loggerWarn(...args),
    debug: jest.fn(),
    error: jest.fn(),
    result: jest.fn(),
  },
}));

import { nodeDevnet } from '../src/cmd/node';
import { CkbLogEntry } from '../src/devnet/log-subscription';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 1234;
  kill = jest.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
}

describe('foreground node output modes', () => {
  let ckb: FakeChild;
  let miner: FakeChild;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTcpListenAddress.mockReturnValue('127.0.0.1:18114');
    mockSubscribe.mockReturnValue({ close: jest.fn() });
    ckb = new FakeChild();
    miner = new FakeChild();
    mockSpawn.mockReturnValueOnce(ckb).mockImplementationOnce(() => {
      process.nextTick(() => miner.emit('spawn'));
      return miner;
    });
  });

  it('does not print node/miner output by default', async () => {
    await nodeDevnet({});
    loggerInfo.mockClear();
    ckb.stdout.emit('data', 'noisy node line');
    miner.stdout.emit('data', 'noisy miner line');
    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).not.toContain('noisy node line');
    expect(printed).not.toContain('noisy miner line');
  });

  it('relays node/miner output when --verbose is set', async () => {
    await nodeDevnet({ verbose: true });
    loggerInfo.mockClear();
    ckb.stdout.emit('data', 'noisy node line');
    miner.stdout.emit('data', 'noisy miner line');
    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toContain('noisy node line');
    expect(printed).toContain('noisy miner line');
  });

  it('streams ckb-script log entries to the console and hides the rest', async () => {
    await nodeDevnet({});
    expect(mockSubscribe).toHaveBeenCalledWith('127.0.0.1:18114', expect.any(Function), expect.any(Function));
    const onEntry = mockSubscribe.mock.calls[0][1] as (entry: CkbLogEntry) => void;

    onEntry({ message: 'script group: 0xabcd DEBUG OUTPUT: hello', level: 'DEBUG', target: 'ckb-script', date: '' });
    onEntry({ message: 'block 123', level: 'INFO', target: 'ckb_chain::chain', date: '' });

    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toContain('CKB-Script:');
    expect(printed).toContain('script group: 0xabcd DEBUG OUTPUT: hello');
    expect(printed).not.toContain('block 123');
  });

  it('streams real ckb_script::verify debug log entries and filters unverified/unrelated entries', async () => {
    await nodeDevnet({});
    const onEntry = mockSubscribe.mock.calls[0][1] as (entry: CkbLogEntry) => void;

    onEntry({
      message:
        'script group: Byte32(0xafa75b18ff86fe7e188169be16b3279833ceeb197b0d14abf23ff2b005199f8d) DEBUG OUTPUT: OFFCKB_DIAGNOSTIC_FIRST',
      level: 'DEBUG',
      target: 'ckb_script::verify',
      date: '',
    });
    onEntry({
      message: 'ordinary verify line without debug marker',
      level: 'DEBUG',
      target: 'ckb_script::verify',
      date: '',
    });
    onEntry({
      message: 'other script target DEBUG OUTPUT: test',
      level: 'DEBUG',
      target: 'ckb_script_other',
      date: '',
    });

    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toContain('CKB-Script:');
    expect(printed).toContain(
      'script group: Byte32(0xafa75b18ff86fe7e188169be16b3279833ceeb197b0d14abf23ff2b005199f8d) DEBUG OUTPUT: OFFCKB_DIAGNOSTIC_FIRST',
    );
    expect(printed).not.toContain('ordinary verify line without debug marker');
    expect(printed).not.toContain('other script target');
  });

  it('strips terminal control sequences from script log entries', async () => {
    await nodeDevnet({});
    const onEntry = mockSubscribe.mock.calls[0][1] as (entry: CkbLogEntry) => void;

    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    onEntry({
      message: `${esc}[31mred${esc}[0m ${bel}bell\r`,
      level: 'DEBUG',
      target: 'ckb-script',
      date: '',
    });

    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toContain('red bell');
    expect(printed).not.toContain(esc);
    expect(printed).not.toContain(bel);
    expect(printed).not.toContain('\r');
  });

  it('skips the subscription when the node has no TCP listen address', async () => {
    mockTcpListenAddress.mockReturnValue(undefined);
    await nodeDevnet({});
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('points the user at offckb logs once the node is ready', async () => {
    await nodeDevnet({});
    const printed = loggerInfo.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toMatch(/offckb logs -f/);
  });
});
