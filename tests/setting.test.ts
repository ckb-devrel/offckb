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

import { readSettings, readSettingsStrict, writeSettings, defaultSettings, configPath } from '../src/cfg/setting';
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

    it('falls back to defaults and logs error when config file contains corrupted JSON', () => {
      fs.writeFileSync(configPath, '{ corrupted json:');

      const settings = readSettings();
      expect(settings.bins.defaultCKBVersion).toBe(defaultSettings.bins.defaultCKBVersion);
      expect(logger.error).toHaveBeenCalledWith('Error reading settings:', expect.any(SyntaxError));
    });

    describe('strict mode (readSettingsStrict)', () => {
      it('returns default settings when config file does not exist', () => {
        expect(fs.existsSync(configPath)).toBe(false);
        const settings = readSettingsStrict();
        expect(settings.bins.defaultCKBVersion).toBe(defaultSettings.bins.defaultCKBVersion);
      });

      it('throws Error containing configPath and reason when JSON is corrupted', () => {
        fs.writeFileSync(configPath, '{ invalid: json');

        expect(() => readSettingsStrict()).toThrow(
          expect.objectContaining({
            message: expect.stringMatching(new RegExp(`Failed to read settings from .*${path.basename(configPath)}`)),
          }),
        );
        expect(() => readSettingsStrict()).toThrow(configPath);
      });

      it('throws Error containing configPath when file read fails', () => {
        writeConfig({ proxy: { host: '127.0.0.1', port: 8080 } });
        const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        });

        try {
          expect(() => readSettingsStrict()).toThrow(configPath);
        } finally {
          readSpy.mockRestore();
        }
      });

      it('throws Error containing configPath when validation fails', () => {
        fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));

        expect(() => readSettingsStrict()).toThrow(configPath);
        expect(() => readSettingsStrict()).toThrow('Settings must be a JSON object');
      });

      it('rejects corrupted sections like an array bins or non-object tools', () => {
        fs.writeFileSync(configPath, JSON.stringify({ bins: [] }));
        expect(() => readSettingsStrict()).toThrow('bins must be an object');

        fs.writeFileSync(configPath, JSON.stringify({ bins: null }));
        expect(() => readSettingsStrict()).toThrow('bins must be an object');

        fs.writeFileSync(configPath, JSON.stringify({ tools: null }));
        expect(() => readSettingsStrict()).toThrow('tools must be an object');

        fs.writeFileSync(configPath, JSON.stringify({ tools: 'invalid' }));
        expect(() => readSettingsStrict()).toThrow('tools must be an object');

        // proxy: null is allowed
        fs.writeFileSync(configPath, JSON.stringify({ proxy: null }));
        expect(readSettingsStrict().proxy).toBeNull();
      });
    });
  });

  describe('writeSettings', () => {
    it('creates config file and parent directory when file does not exist', () => {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      expect(fs.existsSync(configPath)).toBe(false);

      const settings = readSettings();
      settings.proxy = { host: '10.0.0.1', port: 3128 };
      writeSettings(settings);

      expect(fs.existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(parsed.proxy).toEqual({ host: '10.0.0.1', port: 3128 });
    });

    it('leaves no temporary files after successful save', () => {
      const settings = readSettings();
      writeSettings(settings);

      const dirFiles = fs.readdirSync(path.dirname(configPath));
      const tempFiles = dirFiles.filter((f) => f.includes('.tmp'));
      expect(tempFiles).toHaveLength(0);
    });

    it('preserves existing file permissions when saving atomically', () => {
      writeConfig({ proxy: { host: '127.0.0.1', port: 8080 } });
      fs.chmodSync(configPath, 0o600);
      const initialMode = fs.statSync(configPath).mode & 0o777;

      const settings = readSettings();
      settings.proxy = { host: '127.0.0.1', port: 9090 };
      writeSettings(settings);

      const updatedMode = fs.statSync(configPath).mode & 0o777;
      expect(updatedMode).toBe(initialMode);
    });

    it('throws Error and leaves original file intact when statSync fails with non-ENOENT error', () => {
      writeConfig({ proxy: { host: 'original.proxy', port: 8080 } });
      const originalContent = fs.readFileSync(configPath, 'utf8');

      const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      try {
        const settings = readSettings();
        settings.proxy = { host: 'new.proxy', port: 9090 };
        expect(() => writeSettings(settings)).toThrow(configPath);
        expect(() => writeSettings(settings)).toThrow('EACCES');
      } finally {
        statSpy.mockRestore();
      }

      // Original content is unchanged
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
      // Temporary file was cleaned up
      const dirFiles = fs.readdirSync(path.dirname(configPath));
      expect(dirFiles.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    });

    it('throws Error and leaves original file intact when writeFileSync fails', () => {
      writeConfig({ proxy: { host: 'original.proxy', port: 8080 } });
      const originalContent = fs.readFileSync(configPath, 'utf8');

      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      try {
        const settings = readSettings();
        settings.proxy = { host: 'new.proxy', port: 9090 };
        expect(() => writeSettings(settings)).toThrow(
          expect.objectContaining({
            message: expect.stringMatching(new RegExp(`Failed to write settings to .*${path.basename(configPath)}`)),
          }),
        );
        expect(() => writeSettings(settings)).toThrow('ENOSPC');
      } finally {
        writeSpy.mockRestore();
      }

      // Original content is unchanged
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
      // No temporary file remained
      const dirFiles = fs.readdirSync(path.dirname(configPath));
      expect(dirFiles.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    });

    it('throws Error and leaves original file intact when renameSync fails', () => {
      writeConfig({ proxy: { host: 'original.proxy', port: 8080 } });
      const originalContent = fs.readFileSync(configPath, 'utf8');

      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      try {
        const settings = readSettings();
        settings.proxy = { host: 'new.proxy', port: 9090 };
        expect(() => writeSettings(settings)).toThrow(configPath);
        expect(() => writeSettings(settings)).toThrow('EACCES');
      } finally {
        renameSpy.mockRestore();
      }

      // Original content is unchanged
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalContent);
      // Temporary file was cleaned up
      const dirFiles = fs.readdirSync(path.dirname(configPath));
      expect(dirFiles.filter((f) => f.includes('.tmp'))).toHaveLength(0);
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
