// Opt-in live integration test. Requires a build, CKB 0.208.0 and the public Explorer provider installed in packages/plugin-explorer.
// All settings, ports, chain data and registrations belong to a fresh temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(project, 'build/index.js');
const ckb = process.argv[2];
if (!ckb || !fs.statSync(ckb).isFile()) throw new Error('Usage: node scripts/plugin-smoke.mjs <CKB-0.208.0-binary>');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offckb plugin smoke ')));
const chain = path.join(root, 'devnet');
const home = path.join(root, 'plugins');
const env = {
  ...process.env,
  OFFCKB_TEST_SECRET: 'sandbox-canary',
  SSH_AUTH_SOCK: '/private/sandbox-canary-agent.sock',
  OFFCKB_SMOKE_ROOT: root,
  OFFCKB_PLUGIN_HOME: home,
  OFFCKB_CLI_PATH: cli,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  APPDATA: path.join(root, 'appdata'),
  LOCALAPPDATA: path.join(root, 'localappdata'),
};
// Redirect os.homedir in this test worker before the production bundle loads. HOME itself stays unchanged.
const worker = `require('os').homedir = () => process.env.OFFCKB_SMOKE_ROOT; process.argv = [process.execPath, ${JSON.stringify(cli)}, ...process.argv.slice(1)]; require(${JSON.stringify(cli)}).runCli(process.argv);`;
const children = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function invoke(args) {
  return execFileSync(process.execPath, ['-e', worker, '--', ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function start(args) {
  const child = spawn(process.execPath, ['-e', worker, '--', ...args], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, stdout: '', stderr: '', code: undefined };
  children.add(state);
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  state.closed = new Promise((resolve) =>
    child.once('close', (code) => {
      state.code = code;
      children.delete(state);
      resolve(code);
    }),
  );
  return state;
}
async function stop(state) {
  if (state.code !== undefined) return;
  state.child.kill('SIGTERM');
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 10000);
  try {
    await state.closed;
  } finally {
    clearTimeout(timer);
  }
}
async function rpc(url, method) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(3000),
  });
  const value = await response.json();
  if (value.error) throw new Error(JSON.stringify(value.error));
  return value.result;
}

try {
  const [rpcPort, proxyPort, tcpPort, p2pPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  fs.cpSync(path.join(project, 'ckb/devnet'), chain, {
    recursive: true,
    filter: (file) => file !== path.join(project, 'ckb/devnet/data'),
  });
  const config = path.join(chain, 'ckb.toml');
  fs.writeFileSync(
    config,
    fs
      .readFileSync(config, 'utf8')
      .replaceAll('127.0.0.1:8114', `127.0.0.1:${rpcPort}`)
      .replaceAll('127.0.0.1:18114', `127.0.0.1:${tcpPort}`)
      .replaceAll('/ip4/0.0.0.0/tcp/8115', `/ip4/127.0.0.1/tcp/${p2pPort}`),
  );
  const miner = path.join(chain, 'ckb-miner.toml');
  fs.writeFileSync(miner, fs.readFileSync(miner, 'utf8').replaceAll('http://ckb:8114/', rpcUrl));
  const bins = path.join(root, 'bins');
  const binary = path.join(bins, '0.208.0', process.platform === 'win32' ? 'ckb.exe' : 'ckb');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(ckb, binary);
  fs.chmodSync(binary, 0o755);
  const settings =
    process.platform === 'darwin'
      ? path.join(root, 'Library/Preferences/offckb-nodejs/settings.json')
      : process.platform === 'win32'
        ? path.join(env.APPDATA, 'offckb-nodejs/Config/settings.json')
        : path.join(env.XDG_CONFIG_HOME, 'offckb-nodejs/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(
    settings,
    JSON.stringify({
      bins: { rootFolder: bins, defaultCKBVersion: '0.208.0' },
      devnet: {
        rpcUrl,
        rpcProxyPort: proxyPort,
        configPath: chain,
        dataPath: path.join(chain, 'data'),
        transactionsPath: path.join(chain, 'transactions'),
        debugFullTransactionsPath: path.join(chain, 'full-transactions'),
      },
    }),
  );

  invoke(['--json', 'plugin', 'link', path.join(project, 'examples/plugins/context-probe')]);
  const probe = JSON.parse(invoke(['--json', 'context-probe', '--', '--json', 'a b', '--', 'tail']));
  assert.deepEqual(probe.argv, ['--json', 'a b', '--', 'tail']);
  assert.equal(probe.output, 'json');
  assert.equal(probe.cliEntry, cli);
  assert.equal(probe.kind, 'pure-devnet');
  assert.match(invoke(['context-probe', '--help']), /Usage/);
  console.log('PASS: production bundle, exact argv, single JSON result, offline help');

  const validConfig = fs.readFileSync(config, 'utf8');
  try {
    fs.writeFileSync(config, 'invalid = [');
    const unavailable = JSON.parse(invoke(['--json', 'context-probe']));
    assert.equal(unavailable.kind, 'unknown');
    assert.equal(unavailable.diagnosticCode, 'LIST_HASHES_FAILED');
    assert.equal(fs.existsSync(path.join(home, 'context-probe.running')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), []);
  } finally {
    fs.writeFileSync(config, validConfig);
  }
  console.log('PASS: failed local list-hashes does not block a chain-independent plugin, clean context');

  const attacker = path.join(root, 'attacker');
  fs.mkdirSync(attacker);
  const secret = path.join(root, 'private.txt');
  const escapedWrite = path.join(root, 'escaped.txt');
  fs.writeFileSync(secret, 'private-canary');
  const listener = net.createServer((socket) => {
    socket.destroy();
    throw new Error('Sandbox escaped network isolation');
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(attacker, 'package.json'),
    JSON.stringify({
      name: 'sandbox-probe',
      version: '1.0.0',
      offckb: { apiVersion: 1, command: 'sandbox-probe', entry: 'cli.cjs' },
    }),
  );
  fs.writeFileSync(
    path.join(attacker, 'cli.cjs'),
    `
    const fs=require('fs'),cp=require('child_process'),net=require('net');
    const context=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
    const denied=(fn)=>{try{fn();return false;}catch{return true;}};
    const link=context.plugin.dataPath+'/escape';fs.symlinkSync(${JSON.stringify(secret)},link);
    fs.writeFileSync(context.plugin.cachePath+'/own','allowed');
    const result={read:denied(()=>fs.readFileSync(${JSON.stringify(secret)})),write:denied(()=>fs.writeFileSync(${JSON.stringify(escapedWrite)},'bad')),symlink:denied(()=>fs.readFileSync(link)),child:denied(()=>cp.execFileSync('/bin/cat',[${JSON.stringify(secret)}],{stdio:'pipe'})),env:process.env.OFFCKB_TEST_SECRET===undefined&&process.env.SSH_AUTH_SOCK===undefined,rpc:context.devnet.rpcUrl===''};
    const socket=net.connect(${listener.address().port},'127.0.0.1');
    const timer=setTimeout(()=>{socket.destroy();result.network=true;finish();},1000);
    function finish(){clearTimeout(timer);console.log(JSON.stringify(result));if(Object.values(result).some(value=>value!==true))process.exitCode=1;}
    socket.once('connect',()=>{socket.destroy();result.network=false;finish();});
    socket.once('error',()=>{result.network=true;finish();});
  `,
  );
  try {
    invoke(['plugin', 'link', attacker]);
    const result = JSON.parse(invoke(['--json', 'sandbox-probe']));
    assert.ok(Object.values(result).every((value) => value === true));
    assert.equal(fs.existsSync(escapedWrite), false);
    invoke(['plugin', 'unlink', 'sandbox-probe']);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
  console.log(
    'PASS: OS sandbox blocks secret reads, writes, symlink/child escapes, inherited credentials and direct networking',
  );

  const deployedProject = path.join(root, 'deployed project');
  const deployment = path.join(deployedProject, 'deployment');
  fs.mkdirSync(deployment, { recursive: true });
  fs.writeFileSync(
    path.join(deployment, 'scripts.json'),
    JSON.stringify({
      devnet: {
        'sandbox-fixture': { script: { codeHash: '0x' + 'ab'.repeat(32), hashType: 'type' } },
      },
    }),
  );
  invoke([
    '--json',
    'plugin',
    'link',
    path.join(project, 'packages/plugin-explorer'),
    '--read',
    deployment,
    '--allow',
    'devnet-read',
    '--allow',
    'project-deployment',
    '--allow',
    'serve',
  ]);
  for (let cycle = 0; cycle < 2; cycle++) {
    const node = start(['--json', 'node']);
    try {
      await until(async () => {
        if (node.code !== undefined) throw new Error(`Node exited: ${node.stderr}`);
        try {
          return (await rpc(rpcUrl, 'get_tip_block_number')) !== undefined;
        } catch {
          return false;
        }
      }, 'devnet RPC');
      const explorer = start(['--json', '--plugin-port', '0', 'explorer', '--project', deployedProject]);
      try {
        await until(() => {
          if (explorer.code !== undefined) throw new Error(`Explorer exited: ${explorer.stderr}`);
          return explorer.stdout.trim().startsWith('{');
        }, 'Explorer ready result');
        const ready = JSON.parse(explorer.stdout);
        assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/);
        assert.equal((await fetch(ready.url)).status, 200);
        const info = await (await fetch(`${ready.url}/api/info`)).json();
        assert.match(info.rpcUrl, /^http:\/\/127\.0\.0\.1:/);
        assert.notEqual(info.rpcUrl, rpcUrl);
        assert.deepEqual(info.projects, [deployedProject]);
        const overview = await fetch(`${ready.url}/api/overview`);
        assert.equal(overview.status, 200);
        const summary = await overview.json();
        assert.equal(summary.knownScripts.project, 1);
        assert.equal(summary.scripts[0].name, 'sandbox-fixture');
        assert.throws(() => invoke(['--json', 'plugin', 'unlink', 'explorer']), /Command failed/);
      } finally {
        await stop(explorer);
      }
      assert.equal(explorer.code, 143);
      assert.equal(explorer.stdout.trim().split('\n').length, 1);
      assert.equal(fs.existsSync(path.join(home, 'explorer.running')), false);
      assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), []);
      assert.ok(await rpc(rpcUrl, 'get_tip_block_number'));
      console.log(
        `PASS: live Explorer cycle ${cycle + 1}, page/API, RPC context, SIGTERM, CKB remains up, clean context`,
      );
    } finally {
      await stop(node);
    }
    if (cycle === 0) invoke(['--json', 'clean', '--data']);
  }
  fs.writeFileSync(path.join(chain, 'fork.json'), JSON.stringify({ source: 'custom', firstRunPending: false }));
  assert.throws(() => invoke(['--json', '--plugin-port', '0', 'explorer']), /Command failed/);
  fs.unlinkSync(path.join(chain, 'fork.json'));
  invoke(['--json', 'plugin', 'unlink', 'explorer']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), []);
  console.log('PASS: chain reset/restart, unknown fork rejection, unlink');
} finally {
  await Promise.all([...children].map(stop));
  fs.rmSync(root, { recursive: true, force: true });
}
