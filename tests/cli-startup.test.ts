import { execFileSync, spawnSync } from 'child_process';
import path from 'path';

it('starts the bundled CLI without deprecation warnings', () => {
  const root = path.resolve(__dirname, '..');
  // Build here because the test suite runs before the build step in CI.
  execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { cwd: root, timeout: 120000 });

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_NO_WARNINGS;

  const result = spawnSync(
    process.execPath,
    ['--pending-deprecation', '--throw-deprecation', path.join(root, 'build/index.js'), '--help'],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 },
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: offckb');
}, 120000);
