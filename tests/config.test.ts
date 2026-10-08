import fs from 'fs';
import path from 'path';

// Redirect offckb config/data/cache roots into a temp directory
jest.mock('../src/cfg/env-path', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'offckb-config-test-'));
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

import { configPath } from '../src/cfg/setting';
import { Config, ConfigAction, ConfigItem } from '../src/cmd/config';
import { runCli } from '../src/cli';
import { logger } from '../src/util/logger';

function captureStderr() {
  const writes: string[] = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return {
    writes,
    text: () => writes.join(''),
    restore: () => spy.mockRestore(),
  };
}

describe('config command and error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    process.exitCode = undefined;
    logger.setJsonMode(false);
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
    logger.setJsonMode(false);
  });

  describe('Config handler', () => {
    it('creates config file when missing', async () => {
      fs.rmSync(configPath, { force: true });
      expect(fs.existsSync(configPath)).toBe(false);

      await Config(ConfigAction.set, ConfigItem.ckbVersion, '0.208.0');

      expect(fs.existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(parsed.bins.defaultCKBVersion).toBe('0.208.0');
    });

    it('preserves other existing settings when modifying one setting', async () => {
      const initial = {
        proxy: { host: '192.168.1.100', port: 8080 },
        bins: { defaultCKBVersion: '0.200.0' },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));

      await Config(ConfigAction.set, ConfigItem.ckbVersion, '0.208.0');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(updated.bins.defaultCKBVersion).toBe('0.208.0');
      expect(updated.proxy).toEqual({ host: '192.168.1.100', port: 8080 });
    });

    it('stops modification and preserves original file when settings.json is corrupted', async () => {
      const corruptContent = '{ "proxy": broken json';
      fs.writeFileSync(configPath, corruptContent);

      await expect(Config(ConfigAction.set, ConfigItem.ckbVersion, '0.208.0')).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringMatching(new RegExp(`Failed to read settings from .*${path.basename(configPath)}`)),
        }),
      );

      // Original corrupted content is preserved untouched
      expect(fs.readFileSync(configPath, 'utf8')).toBe(corruptContent);
    });

    it('stops modification and preserves original file when file read throws EACCES', async () => {
      const initial = { proxy: { host: '192.168.1.100', port: 8080 } };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));

      const renameSpy = jest.spyOn(fs, 'renameSync');
      const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      try {
        await expect(Config(ConfigAction.set, ConfigItem.ckbVersion, '0.208.0')).rejects.toThrow(
          expect.objectContaining({
            message: expect.stringMatching(new RegExp(`Failed to read settings from .*${path.basename(configPath)}`)),
          }),
        );
      } finally {
        readSpy.mockRestore();
        renameSpy.mockRestore();
      }

      // Rename / write was never reached
      expect(renameSpy).not.toHaveBeenCalled();

      // Original content is preserved untouched
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(parsed.proxy).toEqual({ host: '192.168.1.100', port: 8080 });
      expect(parsed.bins).toBeUndefined();
    });

    it('stops modification and preserves original file when required section is null', async () => {
      const invalidContent = JSON.stringify({ bins: null });
      fs.writeFileSync(configPath, invalidContent);

      await expect(Config(ConfigAction.set, ConfigItem.ckbVersion, '0.208.0')).rejects.toThrow(
        'bins must be an object',
      );

      // Original content is preserved untouched
      expect(fs.readFileSync(configPath, 'utf8')).toBe(invalidContent);
    });
  });

  describe('CLI error propagation', () => {
    it('propagates corrupted config read failure through CLI with exitCode 1 and JSON ok:false', async () => {
      const corruptContent = '{ "corrupted": json content';
      fs.writeFileSync(configPath, corruptContent);

      const stderr = captureStderr();
      try {
        await runCli(['node', 'offckb', '--json', 'config', 'set', 'ckb-version', '0.208.0']);
      } finally {
        stderr.restore();
      }

      expect(process.exitCode).toBe(1);
      const output = stderr.text();
      const record = JSON.parse(output.trim());
      expect(record.ok).toBe(false);
      expect(record.code).toBe('COMMAND_FAILED');
      expect(record.message).toContain(configPath);
      // Original corrupted content is preserved untouched
      expect(fs.readFileSync(configPath, 'utf8')).toBe(corruptContent);
    });

    it('propagates write failure through CLI with exitCode 1 and JSON ok:false', async () => {
      const initial = { bins: { defaultCKBVersion: '0.200.0' } };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));

      const writeSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const stderr = captureStderr();
      try {
        await runCli(['node', 'offckb', '--json', 'config', 'set', 'ckb-version', '0.208.0']);
      } finally {
        writeSpy.mockRestore();
        stderr.restore();
      }

      expect(process.exitCode).toBe(1);
      const output = stderr.text();
      const record = JSON.parse(output.trim());
      expect(record.ok).toBe(false);
      expect(record.code).toBe('COMMAND_FAILED');
      expect(record.message).toContain(configPath);
      expect(record.message).toContain('EACCES');
      // Original content is preserved untouched
      const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(current.bins.defaultCKBVersion).toBe('0.200.0');
    });
  });
});
