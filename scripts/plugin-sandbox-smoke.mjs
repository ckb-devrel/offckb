// Native denial tests against the production bundle. No real credentials or chain are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'build/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb sandbox '));
const home = path.join(root, 'plugins');
const env = {
  ...process.env,
  OFFCKB_SANDBOX_TEST_ROOT: root,
  OFFCKB_PLUGIN_HOME: home,
  OFFCKB_CLI_PATH: cli,
  OFFCKB_TEST_SECRET: 'environment-canary',
  SSH_AUTH_SOCK: path.join(root, 'fake-agent.sock'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
};
const makeWorker = (entry) =>
  `require('os').homedir=()=>process.env.OFFCKB_SANDBOX_TEST_ROOT;process.argv=[process.execPath,${JSON.stringify(entry)},...process.argv.slice(1)];require(${JSON.stringify(entry)}).runCli(process.argv);`;
async function invoke(args, expected = 0, entry = cli) {
  const child = spawn(process.execPath, ['-e', makeWorker(entry), '--', ...args], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timer);
  assert.equal(code, expected, stderr || stdout);
  return { stdout, stderr };
}
function plugin(name, code, permissions = []) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', offckb: { apiVersion: 1, command: name, entry: 'cli.cjs', permissions } }),
  );
  fs.writeFileSync(path.join(directory, 'cli.cjs'), code);
  return directory;
}
const upstreamCalls = [];
const rpc = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  upstreamCalls.push({ body: JSON.parse(raw), authorization: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }));
});
let forbiddenConnections = 0;
const forbidden = net.createServer((socket) => {
  forbiddenConnections++;
  socket.destroy();
});
try {
  await Promise.all([
    new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => forbidden.listen(0, '127.0.0.1', resolve)),
  ]);
  const settings =
    process.platform === 'darwin'
      ? path.join(root, 'Library/Preferences/offckb-nodejs/settings.json')
      : path.join(env.XDG_CONFIG_HOME, 'offckb-nodejs/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(
    settings,
    JSON.stringify({ devnet: { rpcUrl: `http://user:rpc-canary@127.0.0.1:${rpc.address().port}` } }),
  );
  const secret = path.join(root, 'private.txt');
  fs.writeFileSync(secret, 'file-canary');
  const escapedWrite = path.join(root, 'escaped.txt');
  const probe = plugin(
    'malicious-probe',
    `
    const fs=require('fs'),cp=require('child_process'),net=require('net');
    const c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
    const denied=fn=>{try{fn();return false;}catch{return true;}};
    fs.symlinkSync(${JSON.stringify(secret)},c.plugin.dataPath+'/escape');
    fs.writeFileSync(c.plugin.cachePath+'/own','allowed');
    const result={read:denied(()=>fs.readFileSync(${JSON.stringify(secret)})),write:denied(()=>fs.writeFileSync(${JSON.stringify(escapedWrite)},'bad')),symlink:denied(()=>fs.readFileSync(c.plugin.dataPath+'/escape')),child:denied(()=>cp.execFileSync(process.execPath,['-e','require("fs").readFileSync('+JSON.stringify(${JSON.stringify(secret)})+')'],{stdio:'pipe'})),env:process.env.OFFCKB_TEST_SECRET===undefined&&process.env.SSH_AUTH_SOCK===undefined,context:!JSON.stringify(c).includes('rpc-canary')&&c.devnet.rpcUrl===''};
    const socket=net.connect(${forbidden.address().port},'127.0.0.1');let finished=false;
    const timer=setTimeout(()=>{socket.destroy();done(true);},1000);
    function done(blocked){if(finished)return;finished=true;clearTimeout(timer);result.network=blocked;console.log(JSON.stringify(result));if(Object.values(result).some(value=>value!==true))process.exitCode=1;}
    socket.once('connect',()=>{socket.destroy();done(false);});socket.once('error',()=>done(true));
  `,
  );
  await invoke(['plugin', 'link', probe]);
  const denied = JSON.parse((await invoke(['--json', 'malicious-probe'])).stdout);
  assert.ok(Object.values(denied).every((value) => value === true));
  assert.equal(fs.existsSync(escapedWrite), false);
  assert.equal(fs.readFileSync(path.join(home, 'cache/malicious-probe/own'), 'utf8'), 'allowed');
  const bare = path.join(root, 'bare-bundle');
  fs.cpSync(path.dirname(cli), bare, { recursive: true });
  assert.match(
    (await invoke(['malicious-probe'], 1, path.join(bare, 'index.js'))).stderr,
    /Sandbox runtime is unavailable/,
  );
  await invoke(['plugin', 'unlink', 'malicious-probe']);
  console.log(
    'PASS: denied file reads/writes, symlinks, child escape, direct networking and inherited/context credentials',
  );

  const reader = plugin(
    'rpc-reader',
    `
    const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
    (async()=>{const call=method=>fetch(c.devnet.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
    const read=await call('get_tip_block_number'),write=await call('send_transaction');let otherBlocked;try{otherBlocked=(await fetch('http://127.0.0.1:${forbidden.address().port}',{signal:AbortSignal.timeout(3000)})).status===403;}catch{otherBlocked=true;}console.log(JSON.stringify({read:read.status,write:write.status,otherBlocked,safe:!JSON.stringify(c).includes('rpc-canary')}));})().catch(error=>{console.error(error);process.exitCode=1;});
  `,
    ['devnet-read'],
  );
  assert.match((await invoke(['plugin', 'link', reader], 1)).stderr, /explicit grants/);
  await invoke(['plugin', 'link', reader, '--allow', 'devnet-read']);
  assert.deepEqual(JSON.parse((await invoke(['--json', 'rpc-reader'])).stdout), {
    read: 200,
    write: 403,
    otherBlocked: true,
    safe: true,
  });
  assert.equal(forbiddenConnections, 0);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].body.method, 'get_tip_block_number');
  assert.equal(upstreamCalls[0].authorization, `Basic ${Buffer.from('user:rpc-canary').toString('base64')}`);
  await invoke(['plugin', 'unlink', 'rpc-reader']);
  const signalled = plugin('signal-exit', "process.kill(process.pid,'SIGTERM');");
  await invoke(['plugin', 'link', signalled]);
  await invoke(['signal-exit'], 143);
  await invoke(['plugin', 'unlink', 'signal-exit']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), []);
  console.log('PASS: explicit grants, read-only RPC gateway, no upstream credential disclosure, lease/context cleanup');
} finally {
  rpc.closeAllConnections();
  rpc.close();
  forbidden.close();
  fs.rmSync(root, { recursive: true, force: true });
}
