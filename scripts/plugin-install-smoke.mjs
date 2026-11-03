// Offline npm/Git integration fixtures against the production CLI. No third-party plugin is executed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';

const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'build/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb plugin installation '));
const home = path.join(root, 'plugins');
const marker = path.join(root, 'install-script-ran');
const repository = path.join(root, 'git source');
const env = {
  ...process.env,
  OFFCKB_PLUGIN_HOME: home,
  OFFCKB_INSTALL_TEST_ROOT: root,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  APPDATA: path.join(root, 'roaming'),
  LOCALAPPDATA: path.join(root, 'local'),
  npm_config_cache: path.join(root, 'npm cache'),
  npm_config_userconfig: path.join(root, 'empty.npmrc'),
  npm_config_globalconfig: path.join(root, 'empty-global.npmrc'),
  npm_config_update_notifier: 'false',
};
fs.writeFileSync(env.npm_config_userconfig, '');
fs.writeFileSync(env.npm_config_globalconfig, '');
// Only the test transport rewrites the already-normalized GitHub URL to a local Git fixture.
// npm still performs a real Git clone/prepare/install. Production has no source/runner override.
const worker = `
require('os').homedir=()=>process.env.OFFCKB_INSTALL_TEST_ROOT;
const cp=require('child_process'),spawn=cp.spawn;
cp.spawn=function(command,args,options){
  if(args&&args[0]&&args[0].endsWith('npm-cli.js'))args=args.map(arg=>arg.startsWith('git+https://github.com/offckb-fixtures/plugin.git')?arg.replace('git+https://github.com/offckb-fixtures/plugin.git',${JSON.stringify(`git+${pathToFileURL(repository).href}`)}):arg);
  return spawn.call(this,command,args,options);
};
process.on('message',signal=>{if(signal==='SIGINT')process.emit('SIGINT');});
process.argv=[process.execPath,${JSON.stringify(cli)},...process.argv.slice(1)];
require(${JSON.stringify(cli)}).runCli(process.argv).finally(()=>process.disconnect());
`;
const active = new Set();
function start(args) {
  const child = spawn(process.execPath, ['-e', worker, '--', ...args], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const result = { child, stdout: '', stderr: '', code: undefined };
  active.add(result);
  child.stdout.on('data', (data) => (result.stdout += data));
  child.stderr.on('data', (data) => (result.stderr += data));
  result.closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      result.code = code;
      active.delete(result);
      resolve(code);
    });
  });
  result.closed.catch(() => {});
  return result;
}
async function invoke(args, expected = 0) {
  const result = start(args);
  const timer = setTimeout(() => result.child.kill('SIGKILL'), 90000);
  try {
    assert.equal(await result.closed, expected, result.stderr || result.stdout);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
const packageName = '@offckb-fixtures/plugin';
const versions = {};
let base;
const registry = http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname === `/${packageName}`) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        name: packageName,
        'dist-tags': { latest: '1.2.0' },
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, value]) => [
            version,
            {
              ...value.manifest,
              dist: { tarball: `${base}/archives/${version}.tgz`, integrity: value.integrity },
            },
          ]),
        ),
      }),
    );
  } else if (pathname.startsWith('/archives/')) {
    const version = path.basename(pathname, '.tgz');
    if (!versions[version]) return res.writeHead(404).end();
    res.end(versions[version].archive);
  } else res.writeHead(404).end();
});
function installed() {
  return JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8')).plugins['installed-probe'];
}
try {
  for (const [version, apiVersion] of [
    ['1.0.0', 1],
    ['1.1.0', 99],
    ['1.2.0', 1],
  ]) {
    const directory = path.join(root, version);
    fs.mkdirSync(directory);
    const manifest = {
      name: packageName,
      version,
      scripts: { postinstall: 'node install.cjs' },
      offckb: { apiVersion, command: 'installed-probe', entry: 'cli.cjs' },
    };
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(directory, 'install.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(marker)},'ran');`,
    );
    fs.writeFileSync(
      path.join(directory, 'cli.cjs'),
      `console.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2)}));if(process.argv.includes('wait'))setInterval(()=>{},1000);`,
    );
    const archive = path.join(root, `${version}.tgz`);
    await tar.c({ file: archive, cwd: directory, prefix: 'package', gzip: true }, [
      'package.json',
      'cli.cjs',
      'install.cjs',
    ]);
    const bytes = fs.readFileSync(archive);
    versions[version] = {
      manifest,
      archive: bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
  }
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${registry.address().port}`;
  env.npm_config_registry = base;
  const first = JSON.parse((await invoke(['--json', 'plugin', 'install', `${packageName}@1.0.0`, '--trust'])).stdout);
  assert.equal(first.mode, 'trusted');
  assert.equal(first.source.resolved, `${packageName}@1.0.0`);
  assert.equal(fs.existsSync(marker), false);
  const firstRoot = path.join(home, 'packages', installed().installation.id);
  assert.deepEqual(JSON.parse((await invoke(['--json', 'installed-probe', 'path with spaces', '--literal'])).stdout), {
    version: '1.0.0',
    args: ['path with spaces', '--literal'],
  });
  assert.match(
    (await invoke(['plugin', 'install', `${packageName}@1.1.0`, '--trust'], 1)).stderr,
    /usable offckb plugin/,
  );
  assert.equal(installed().directory, first.directory);
  assert.equal(fs.existsSync(firstRoot), true);
  const running = start(['--json', 'installed-probe', 'wait']);
  try {
    const deadline = Date.now() + 10000;
    while (!running.stdout.includes('\n')) {
      if (running.code !== undefined || Date.now() > deadline)
        throw new Error(running.stderr || 'Plugin did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match((await invoke(['plugin', 'install', `${packageName}@1.2.0`, '--trust'], 1)).stderr, /running/);
    assert.match((await invoke(['plugin', 'remove', 'installed-probe'], 1)).stderr, /running/);
    assert.equal(installed().directory, first.directory);
  } finally {
    running.child.send('SIGINT');
    assert.equal(await running.closed, 130, running.stderr);
  }
  const data = path.join(home, 'data', createHash('sha256').update(packageName).digest('hex'), 'saved');
  fs.writeFileSync(data, 'keep');
  const updated = JSON.parse((await invoke(['--json', 'plugin', 'install', packageName, '--trust'])).stdout);
  assert.equal(updated.source.resolved, `${packageName}@1.2.0`);
  assert.equal(fs.existsSync(firstRoot), false);
  assert.equal(fs.readFileSync(data, 'utf8'), 'keep');
  assert.equal(JSON.parse((await invoke(['--json', 'plugin', 'list'])).stdout).plugins[0].source.kind, 'npm');
  await invoke(['plugin', 'remove', 'installed-probe']);
  assert.equal(fs.existsSync(updated.directory), false);
  assert.equal(fs.readFileSync(data, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(home, 'packages')), []);
  console.log(
    'PASS: real npm install, pinned provenance, scripts disabled, immediate execution, rollback, running guards, update and removal',
  );

  fs.mkdirSync(repository);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify({
      name: 'github-fixture',
      version: '0.1.0',
      devDependencies: { [packageName]: '1.0.0' },
      files: ['dist', 'prepare.cjs'],
      scripts: { prepare: 'node prepare.cjs' },
      offckb: { apiVersion: 1, command: 'github-probe', entry: 'dist/cli.cjs' },
    }),
  );
  fs.writeFileSync(
    path.join(repository, 'prepare.cjs'),
    `require.resolve('${packageName}/cli.cjs');const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/cli.cjs','console.log(JSON.stringify({ok:true}))');fs.writeFileSync(${JSON.stringify(marker)},'prepared');`,
  );
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=offckb fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: repository, stdio: 'ignore' },
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const source = `github:offckb-fixtures/plugin#${commit}`;
  assert.match((await invoke(['plugin', 'install', source, '--trust'], 1)).stderr, /prebuilt entry/);
  assert.equal(fs.existsSync(marker), false);
  assert.match((await invoke(['plugin', 'install', source, '--allow-scripts'], 1)).stderr, /requires --trust/);
  const github = JSON.parse(
    (await invoke(['--json', 'plugin', 'install', source, '--trust', '--allow-scripts'])).stdout,
  );
  assert.equal(github.source.resolved, source);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'prepared');
  assert.deepEqual(JSON.parse((await invoke(['--json', 'github-probe'])).stdout), { ok: true });
  await invoke(['plugin', 'remove', 'github-probe']);
  // A repository shipping its built entry must install without allowing any lifecycle code.
  fs.rmSync(marker);
  fs.mkdirSync(path.join(repository, 'dist'));
  fs.writeFileSync(path.join(repository, 'dist/cli.cjs'), 'console.log(JSON.stringify({prebuilt:true}))');
  execFileSync('git', ['add', 'dist'], { cwd: repository, stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=offckb fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'prebuilt',
    ],
    { cwd: repository, stdio: 'ignore' },
  );
  const prebuiltCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const prebuilt = JSON.parse(
    (await invoke(['--json', 'plugin', 'install', `github:offckb-fixtures/plugin#${prebuiltCommit}`, '--trust']))
      .stdout,
  );
  assert.equal(prebuilt.source.resolved, `github:offckb-fixtures/plugin#${prebuiltCommit}`);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(JSON.parse((await invoke(['--json', 'github-probe'])).stdout), { prebuilt: true });
  await invoke(['plugin', 'remove', 'github-probe']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'packages')), []);
  console.log(
    'PASS: normalized GitHub source, real offline Git prepare/install, explicit build consent, fixed commit and removal',
  );
} finally {
  for (const result of active) result.child.kill('SIGKILL');
  registry.closeAllConnections();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
