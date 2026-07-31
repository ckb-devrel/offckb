import fs from 'fs';
import path from 'path';

jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Redirect the offckb config/data/cache roots into a temp directory. The root
// is created inside the mock factory because configPath is computed once at
// module import time — a beforeEach reassignment would come too late.
jest.mock('../src/cfg/env-path', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'offckb-settings-'));
  return {
    __esModule: true,
    default: () => ({
      data: nodePath.join(root, 'data'),
      config: nodePath.join(root, 'config'),
      cache: nodePath.join(root, 'cache'),
      log: nodePath.join(root, 'log'),
      temp: nodePath.join(root, 'temp'),
    }),
  };
});

import { readSettings, writeSettings, defaultSettings, configPath } from '../src/cfg/setting';
import { logger } from '../src/util/logger';

describe('settings ckb-tui version handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));

  describe('readSettings', () => {
    it('returns the shipped default when no config file exists', () => {
      expect(readSettings().tools.ckbTui.version).toBe(defaultSettings.tools.ckbTui.version);
    });

    it('upgrades a frozen older bundled ckb-tui version to the shipped default', () => {
      // What a <=0.4.10 `config set` left behind: the whole merged settings,
      // including the then-current bundled version.
      writeConfig({ proxy: { host: '127.0.0.1', port: 8080 }, tools: { ckbTui: { version: 'v0.1.3' } } });

      const settings = readSettings();

      expect(settings.tools.ckbTui.version).toBe(defaultSettings.tools.ckbTui.version);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('v0.1.3'));
      // Unrelated user settings survive the upgrade.
      expect(settings.proxy).toEqual({ host: '127.0.0.1', port: 8080 });
    });

    it('respects a persisted version newer than the shipped default', () => {
      writeConfig({ tools: { ckbTui: { version: 'v9.9.9' } } });

      expect(readSettings().tools.ckbTui.version).toBe('v9.9.9');
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Upgrading bundled ckb-tui'));
    });

    it('leaves the shipped default untouched without logging an upgrade', () => {
      writeConfig({ tools: { ckbTui: { version: defaultSettings.tools.ckbTui.version } } });

      expect(readSettings().tools.ckbTui.version).toBe(defaultSettings.tools.ckbTui.version);
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Upgrading bundled ckb-tui'));
    });

    it('leaves an unparseable version for install-time validation to report', () => {
      writeConfig({ tools: { ckbTui: { version: 'not-a-version' } } });

      expect(readSettings().tools.ckbTui.version).toBe('not-a-version');
    });
  });

  describe('writeSettings', () => {
    it('omits the bundled ckb-tui version when it equals the shipped default', () => {
      const settings = readSettings();
      writeSettings(settings);

      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.tools.ckbTui).toBeUndefined();
    });

    it('persists a bundled ckb-tui version that differs from the shipped default', () => {
      const settings = readSettings();
      settings.tools.ckbTui.version = 'v9.9.9';
      writeSettings(settings);

      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.tools.ckbTui).toEqual({ version: 'v9.9.9' });
    });

    it('does not mutate the caller-provided settings object', () => {
      const settings = readSettings();
      writeSettings(settings);

      expect(settings.tools.ckbTui.version).toBe(defaultSettings.tools.ckbTui.version);
    });

    it('round-trips: a config set on an upgraded install no longer freezes the version', () => {
      // Simulates a user with a frozen v0.1.3 who later runs `config set`:
      // the read upgrades in memory, the write drops the incidental entry.
      writeConfig({ tools: { ckbTui: { version: 'v0.1.3' } } });
      writeSettings(readSettings());

      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.tools.ckbTui).toBeUndefined();
      expect(readSettings().tools.ckbTui.version).toBe(defaultSettings.tools.ckbTui.version);
    });
  });
});
