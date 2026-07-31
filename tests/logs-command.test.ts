import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import winston from 'winston';
import { showLogs } from '../src/cmd/logs';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { UnifiedLogger } from '../src/util/logger';

// Same watcher stub as logs.test.ts: followLogFile's polling cadence belongs
// to libuv, the tests drive change notifications directly.
const mockWatchFile = jest.fn();
const mockUnwatchFile = jest.fn();
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  watchFile: (...args: unknown[]) => mockWatchFile(...args),
  unwatchFile: (...args: unknown[]) => mockUnwatchFile(...args),
}));

const NODE_LINE =
  '2026-07-29 11:31:27.149 +00:00 main INFO ckb_bin::subcommand::run  ckb version: 0.207.0 (8f6cacf 2026-06-10)';
const SCRIPT_LINE =
  '2026-07-29 11:40:01.500 +00:00 GlobalRt-7 DEBUG ckb-script  script group: 0xabcd DEBUG OUTPUT: hello world';
const ERROR_LINE =
  '2026-07-29 11:31:38.636 +00:00 verify_blocks ERROR ckb_chain::verify  unverified_block_rx err: channel disconnected';

interface WinstonInfo {
  [Symbol.for('message')]?: string;
}

class CapturingTransport extends winston.transports.Console {
  logs: string[] = [];
  log(info: WinstonInfo, next: () => void) {
    this.logs.push(info[Symbol.for('message')] ?? '');
    next();
  }
}

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function fixture(): { settings: Settings; transport: CapturingTransport } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-logs-cmd-'));
  tempRoots.push(root);
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.dataPath = path.join(root, 'devnet/data');
  settings.devnet.transactionsPath = path.join(root, 'devnet/transactions');
  const logDir = path.join(settings.devnet.dataPath, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'run.log'), [NODE_LINE, SCRIPT_LINE, ERROR_LINE].join('\n') + '\n');
  fs.writeFileSync(path.join(logDir, 'miner.log'), [ERROR_LINE].join('\n') + '\n');
  fs.writeFileSync(path.join(logDir, 'proxy.log'), 'send_transaction 0xdeadbeef\n');
  const transport = new CapturingTransport();
  return { settings, transport };
}

describe('showLogs', () => {
  it('prints the node log tail by default', () => {
    const { settings, transport } = fixture();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    showLogs('node', { tail: 100 }, settings, log);
    expect(transport.logs).toEqual([NODE_LINE, SCRIPT_LINE, ERROR_LINE]);
  });

  it('prints only ckb-script lines for the script target', () => {
    const { settings, transport } = fixture();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    showLogs('script', { tail: 100 }, settings, log);
    expect(transport.logs).toEqual([SCRIPT_LINE]);
  });

  it('reads miner.log for the miner target', () => {
    const { settings, transport } = fixture();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    showLogs('miner', { tail: 100 }, settings, log);
    expect(transport.logs).toEqual([ERROR_LINE]);
  });

  it('reads proxy.log for the rpc target', () => {
    const { settings, transport } = fixture();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    showLogs('rpc', { tail: 100 }, settings, log);
    expect(transport.logs).toEqual(['send_transaction 0xdeadbeef']);
  });

  it('honors --tail and --grep', () => {
    const { settings, transport } = fixture();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    showLogs('node', { tail: 2, grep: 'ERROR' }, settings, log);
    expect(transport.logs).toEqual([ERROR_LINE]);
  });

  it('throws a helpful error when the log file does not exist', () => {
    const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
    settings.devnet.dataPath = '/nonexistent';
    const log = UnifiedLogger.create({ transports: [new CapturingTransport()] });
    expect(() => showLogs('node', { tail: 100 }, settings, log)).toThrow(/log file not found/i);
  });

  it('in follow mode gates script entries and applies grep to streamed lines', () => {
    const { settings, transport } = fixture();
    type StatListener = (curr: fs.Stats, prev: fs.Stats) => void;
    const listeners: StatListener[] = [];
    mockWatchFile.mockImplementation((_file: unknown, _options: unknown, onChange: StatListener) => {
      listeners.push(onChange);
    });

    try {
      const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
      showLogs('script', { tail: 100, follow: true, grep: 'hello' }, settings, log);
      expect(listeners).toHaveLength(1);
      // The tail already printed the one script line (it contains 'hello').
      expect(transport.logs).toEqual([SCRIPT_LINE]);
      transport.logs.length = 0;

      const runLog = path.join(settings.devnet.dataPath, 'logs', 'run.log');
      const scriptNoGrep = SCRIPT_LINE.replace('hello world', 'goodbye');
      const scriptWithGrep = SCRIPT_LINE.replace('hello world', 'hello again');
      fs.appendFileSync(runLog, [ERROR_LINE, scriptNoGrep, scriptWithGrep, '  hello continuation'].join('\n') + '\n');
      const stat = fs.statSync(runLog);
      listeners[0](stat, stat);

      // ERROR_LINE is not a script entry; scriptNoGrep is filtered by grep;
      // the continuation line belongs to the script entry above it and
      // matches grep, so both it and scriptWithGrep are shown.
      expect(transport.logs).toEqual([scriptWithGrep, '  hello continuation']);
    } finally {
      mockWatchFile.mockReset();
      mockUnwatchFile.mockReset();
    }
  });
});
