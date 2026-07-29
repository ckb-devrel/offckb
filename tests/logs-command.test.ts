import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import winston from 'winston';
import { showLogs } from '../src/cmd/logs';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { UnifiedLogger } from '../src/util/logger';

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

function fixture(): { settings: Settings; transport: CapturingTransport } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-logs-cmd-'));
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
});
