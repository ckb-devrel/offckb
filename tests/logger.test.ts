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
});
