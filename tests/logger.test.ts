import winston from 'winston';
import { UnifiedLogger } from '../src/util/logger';

interface WinstonInfo {
  level: string;
  message: unknown;
  [Symbol.for('message')]?: string;
}

class CapturingTransport extends winston.transports.Console {
  logs: string[] = [];

  log(info: WinstonInfo, next: () => void) {
    this.logs.push(info[Symbol.for('message')] ?? String(info.message));
    next();
  }
}

function createCapturingTransport(): { transport: CapturingTransport; logs: string[] } {
  const transport = new CapturingTransport();
  return { transport, logs: transport.logs };
}

describe('UnifiedLogger JSON mode', () => {
  it('outputs plain text by default', () => {
    const { transport, logs } = createCapturingTransport();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    log.info('hello world');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe('hello world');
  });

  it('outputs structured JSON when jsonMode is enabled', () => {
    const { transport, logs } = createCapturingTransport();
    const log = UnifiedLogger.create({ transports: [transport] });
    log.setJsonMode(true);
    log.info('agent friendly');

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('agent friendly');
    expect(parsed.timestamp).toBeDefined();
  });

  it('joins array messages into a single string in JSON mode', () => {
    const { transport, logs } = createCapturingTransport();
    const log = UnifiedLogger.create({ transports: [transport] });
    log.setJsonMode(true);
    log.info(['line one', 'line two']);

    const parsed = JSON.parse(logs[0]);
    expect(parsed.message).toBe('line one\nline two');
  });

  it('does not filter success messages at the default info level', () => {
    const { transport, logs } = createCapturingTransport();
    const log = UnifiedLogger.create({ transports: [transport], showLevel: false });
    log.success('completed');
    expect(logs).toEqual(['completed']);
  });

  it('emits stable command result and failure records in JSON mode', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = UnifiedLogger.create({ transports: [], jsonMode: true });

    log.result({ command: 'balance', ckb: '42' });
    log.failure('INVALID_ARGUMENT', 'bad amount');

    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({ ok: true, command: 'balance', ckb: '42' });
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: 'bad amount',
    });
    expect(log.hasResult()).toBe(true);
    log.result({ command: 'duplicate' });
    expect(stdout).toHaveBeenCalledTimes(1);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
