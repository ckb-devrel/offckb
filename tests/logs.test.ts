import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseCkbLogLine,
  filterLinesByTarget,
  tailLines,
  grepLines,
  resolveLogPath,
  readLogTail,
  followLogFile,
  LogTarget,
} from '../src/devnet/log-file';
import { defaultSettings, Settings } from '../src/cfg/setting';

// fs.watchFile is a non-configurable property on the fs module, so spyOn
// cannot stub it; route it through a mock factory instead. Everything else
// keeps the real implementation.
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
  '2026-07-29 11:31:38.636 +00:00 verify_blocks ERROR ckb_chain::verify  unverified_block_rx err: receiving on an empty and disconnected channel';

function devnetSettings(root: string): Settings {
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.dataPath = path.join(root, 'devnet/data');
  settings.devnet.transactionsPath = path.join(root, 'devnet/transactions');
  return settings;
}

describe('parseCkbLogLine', () => {
  it('parses a standard CKB log line into fields', () => {
    expect(parseCkbLogLine(NODE_LINE)).toEqual({
      timestamp: '2026-07-29 11:31:27.149 +00:00',
      thread: 'main',
      level: 'INFO',
      target: 'ckb_bin::subcommand::run',
      message: 'ckb version: 0.207.0 (8f6cacf 2026-06-10)',
    });
  });

  it('parses a ckb-script debug line', () => {
    const parsed = parseCkbLogLine(SCRIPT_LINE);
    expect(parsed?.level).toBe('DEBUG');
    expect(parsed?.target).toBe('ckb-script');
    expect(parsed?.message).toBe('script group: 0xabcd DEBUG OUTPUT: hello world');
  });

  it('parses lines whose level is not padded', () => {
    expect(parseCkbLogLine(ERROR_LINE)?.level).toBe('ERROR');
    expect(parseCkbLogLine(ERROR_LINE)?.target).toBe('ckb_chain::verify');
  });

  it('returns null for continuation lines and garbage', () => {
    expect(parseCkbLogLine('    at ckb_chain::verify (src/verify.rs:42)')).toBeNull();
    expect(parseCkbLogLine('')).toBeNull();
    expect(parseCkbLogLine('some random output')).toBeNull();
  });
});

describe('filterLinesByTarget', () => {
  it('keeps only lines from the given target plus their continuation lines', () => {
    const lines = [
      NODE_LINE,
      SCRIPT_LINE,
      '  continuation of the script message',
      ERROR_LINE,
      SCRIPT_LINE.replace('hello world', 'second'),
    ];
    expect(filterLinesByTarget(lines, 'ckb-script')).toEqual([
      SCRIPT_LINE,
      '  continuation of the script message',
      SCRIPT_LINE.replace('hello world', 'second'),
    ]);
  });

  it('drops leading unparsable lines when nothing matched before them', () => {
    expect(filterLinesByTarget(['garbage line', SCRIPT_LINE], 'ckb-script')).toEqual([SCRIPT_LINE]);
  });
});

describe('tailLines', () => {
  it('returns the last N lines', () => {
    expect(tailLines('a\nb\nc\nd\n', 2)).toEqual(['c', 'd']);
  });

  it('returns all lines when fewer than N exist', () => {
    expect(tailLines('a\nb\n', 10)).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty content', () => {
    expect(tailLines('', 5)).toEqual([]);
  });
});

describe('grepLines', () => {
  it('keeps lines containing the substring', () => {
    expect(grepLines([NODE_LINE, SCRIPT_LINE], 'DEBUG OUTPUT')).toEqual([SCRIPT_LINE]);
  });
});

describe('resolveLogPath', () => {
  const settings = devnetSettings('/data');
  const logsDir = path.join(settings.devnet.dataPath, 'logs');
  const cases: Array<[LogTarget, string]> = [
    ['node', path.join(logsDir, 'run.log')],
    ['script', path.join(logsDir, 'run.log')],
    ['miner', path.join(logsDir, 'miner.log')],
    // proxy.log resolves via transactionsPath and is made absolute.
    ['rpc', path.resolve(settings.devnet.transactionsPath, '..', 'data', 'logs', 'proxy.log')],
  ];
  it.each(cases)('resolves %s logs to %s', (target, expected) => {
    expect(resolveLogPath(target, settings)).toBe(expected);
  });
});

describe('readLogTail (file reading)', () => {
  it('reads the last N lines of a log file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-logs-'));
    const file = path.join(dir, 'run.log');
    fs.writeFileSync(file, [NODE_LINE, SCRIPT_LINE, ERROR_LINE].join('\n') + '\n');
    expect(readLogTail(file, 2)).toEqual([SCRIPT_LINE, ERROR_LINE]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws a helpful error when the file is missing', () => {
    expect(() => readLogTail('/nonexistent/run.log', 10)).toThrow(/log file not found/i);
  });
});

describe('followLogFile', () => {
  it('emits appended lines until stopped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-logs-'));
    const file = path.join(dir, 'run.log');
    fs.writeFileSync(file, `${NODE_LINE}\n`);

    // Stub the watcher plumbing: libuv's stat-polling cadence is Node's
    // business (and proved flaky on CI runners), what we test is the offset
    // tracking and line splitting once a change notification arrives.
    type StatListener = (curr: fs.Stats, prev: fs.Stats) => void;
    const listeners: StatListener[] = [];
    mockWatchFile.mockImplementation((_file: unknown, _options: unknown, onChange: StatListener) => {
      listeners.push(onChange);
    });

    try {
      const seen: string[] = [];
      const stop = followLogFile(file, (line) => seen.push(line));
      expect(listeners).toHaveLength(1);

      fs.appendFileSync(file, `${SCRIPT_LINE}\n`);
      const stat = fs.statSync(file);
      listeners[0](stat, stat);
      stop();

      expect(seen).toEqual([SCRIPT_LINE]);
      expect(mockUnwatchFile).toHaveBeenCalled();
    } finally {
      mockWatchFile.mockReset();
      mockUnwatchFile.mockReset();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
