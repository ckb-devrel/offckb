import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { assertPlainDevnet } from '../src/fiber/ckb-env';
import { FORK_STATE_FILE } from '../src/devnet/fork';

/**
 * Fiber only runs on a plain local devnet: any fork.json — valid or not —
 * rejects startup, because a forked devnet's data belongs to its source chain.
 */
describe('assertPlainDevnet', () => {
  let root: string;
  let settings: Settings;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-ckb-env-'));
    settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
    settings.devnet.configPath = path.join(root, 'devnet');
    fs.mkdirSync(settings.devnet.configPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when no fork.json exists', () => {
    expect(() => assertPlainDevnet(settings)).not.toThrow();
  });

  it('rejects a devnet recorded as a fork', () => {
    fs.writeFileSync(
      path.join(settings.devnet.configPath, FORK_STATE_FILE),
      JSON.stringify({ source: 'testnet', sourceDir: '/nonexistent', firstRunPending: false }),
    );
    expect(() => assertPlainDevnet(settings)).toThrow('forked devnet');
  });

  it('rejects an unparseable fork.json — cannot verify this is a plain chain', () => {
    fs.writeFileSync(path.join(settings.devnet.configPath, FORK_STATE_FILE), 'not json');
    expect(() => assertPlainDevnet(settings)).toThrow('cannot verify');
  });
});
