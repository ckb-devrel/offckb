import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(__dirname, '..');
const cliPath = path.join(root, 'build/index.js');

beforeAll(() => {
  // Build here because the test suite runs before the build step in CI.
  execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { cwd: root, timeout: 120000 });
}, 120000);

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_NO_WARNINGS;
  return env;
}

it('starts the bundled CLI without deprecation warnings', () => {
  const result = spawnSync(process.execPath, ['--pending-deprecation', '--throw-deprecation', cliPath, '--help'], {
    cwd: root,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 15000,
  });

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: offckb');
});

it.each([
  ['invalid JSON', 'before'],
  ['invalid JSON', 'after'],
  ['unreadable', 'before'],
  ['unreadable', 'after'],
  ['invalid JSON', 'plain'],
])('formats startup diagnostics for %s settings with %s JSON flag', (condition, flagPosition) => {
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-cli-startup-')));
  const configDir =
    process.platform === 'darwin'
      ? path.join(fixtureRoot, 'Library', 'Preferences', 'offckb-nodejs')
      : process.platform === 'win32'
        ? path.join(fixtureRoot, 'offckb-nodejs', 'Config')
        : path.join(fixtureRoot, 'config', 'offckb-nodejs');
  const configPath = path.join(configDir, 'settings.json');
  const preloadPath = path.join(fixtureRoot, 'isolate.cjs');
  const content = condition === 'invalid JSON' ? '{unfinished' : '{"bins":{"defaultCKBVersion":"0.203.0"}}';
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, content);
    // Isolate the child's macOS home, Windows app roots and Linux XDG roots.
    // Inject EACCES only for settings reads so this also works on Windows/root CI.
    fs.writeFileSync(
      preloadPath,
      `require('os').homedir = () => __dirname;
if (process.env.OFFCKB_TEST_DENY_SETTINGS === '1') {
  const fs = require('fs');
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === process.env.OFFCKB_TEST_SETTINGS_PATH) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return readFileSync.call(this, file, ...args);
  };
}
`,
    );
    const args = ['config', 'set', 'proxy', 'http://127.0.0.1:19091'];
    if (flagPosition === 'before') args.unshift('--json');
    if (flagPosition === 'after') args.push('--json');
    const result = spawnSync(process.execPath, ['--require', preloadPath, cliPath, ...args], {
      cwd: root,
      env: {
        ...cleanEnv(),
        APPDATA: fixtureRoot,
        LOCALAPPDATA: fixtureRoot,
        XDG_CONFIG_HOME: path.join(fixtureRoot, 'config'),
        XDG_DATA_HOME: path.join(fixtureRoot, 'data'),
        XDG_CACHE_HOME: path.join(fixtureRoot, 'cache'),
        OFFCKB_TEST_DENY_SETTINGS: condition === 'unreadable' ? '1' : '0',
        OFFCKB_TEST_SETTINGS_PATH: configPath,
      },
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
    if (flagPosition === 'plain') {
      expect(result.stderr).toContain('Error reading settings:');
      expect(result.stderr).toContain(`Failed to read settings from ${configPath}`);
    } else {
      const records = result.stderr
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.slice(0, -1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'error', message: expect.stringContaining('Error reading settings:') }),
        ]),
      );
      expect(records.at(-1)).toEqual({
        ok: false,
        code: 'COMMAND_FAILED',
        message: expect.stringContaining(configPath),
      });
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
