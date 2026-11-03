// Production-bundle trusted-mode contract tests. All files, credentials and services are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'build/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb trusted '));
const home = path.join(root, 'plugins');
const env = {
  ...process.env,
  OFFCKB_TRUSTED_TEST_ROOT: root,
  OFFCKB_PLUGIN_HOME: home,
  OFFCKB_CLI_PATH: cli,
  OFFCKB_TEST_SECRET: 'environment-canary',
  SSH_AUTH_SOCK: path.join(root, 'fake-agent.sock'),
  NODE_OPTIONS: '--no-warnings',
  NODE_PATH: path.join(root, 'fake-node-path'),
  NODE_USE_ENV_PROXY: '0',
  HTTP_PROXY: 'http://user:proxy-canary@127.0.0.1:1',
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  APPDATA: path.join(root, 'roaming'),
  LOCALAPPDATA: path.join(root, 'local'),
};
const worker = `
require('os').homedir=()=>process.env.OFFCKB_TRUSTED_TEST_ROOT;
const Module=require('module'),resolve=Module._resolveFilename;
Module._resolveFilename=function(request,...args){
  if(request.startsWith('@anthropic-ai/sandbox-runtime'))throw new Error('Test: sandbox runtime unavailable');
  return resolve.call(this,request,...args);
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
  const running = { child, stdout: '', stderr: '', code: undefined };
  active.add(running);
  child.stdout.on('data', (value) => (running.stdout += value));
  child.stderr.on('data', (value) => (running.stderr += value));
  running.closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      active.delete(running);
      running.code = code;
      resolve(code);
    });
  });
  running.closed.catch(() => {});
  return running;
}
async function invoke(args, expected = 0) {
  const running = start(args);
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 20000);
  try {
    assert.equal(await running.closed, expected, running.stderr || running.stdout);
    return running;
  } finally {
    clearTimeout(timer);
  }
}
function plugin(name, code, permissions = []) {
  const directory = path.join(root, `${name} package`);
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
  let body = '';
  for await (const chunk of req) body += chunk;
  upstreamCalls.push({ body: JSON.parse(body), authorization: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }));
});
try {
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const settings =
    process.platform === 'darwin'
      ? path.join(root, 'Library/Preferences/offckb-nodejs/settings.json')
      : process.platform === 'win32'
        ? path.join(env.APPDATA, 'offckb-nodejs/Config/settings.json')
        : path.join(env.XDG_CONFIG_HOME, 'offckb-nodejs/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const config = JSON.stringify({ devnet: { rpcUrl: `http://user:rpc-canary@127.0.0.1:${rpc.address().port}` } });
  fs.writeFileSync(settings, config);
  const canary = path.join(root, 'outside-package.txt');
  fs.writeFileSync(canary, 'trusted mode has user file access');
  const probe = plugin(
    'trusted-probe',
    `const fs=require('fs');
if(process.argv.includes('--help')){console.log(JSON.stringify({help:true,context:process.env.OFFCKB_PLUGIN_CONTEXT||null}));}
else{
  const c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
  fs.writeFileSync(require('path').join(c.plugin.cachePath,'own'),'cache');
  console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),invocation:c.cwd,backend:c.sandbox.backend,rpc:c.devnet.rpcUrl,output:c.output,context:process.env.OFFCKB_PLUGIN_CONTEXT,tmp:require('os').tmpdir(),canary:fs.readFileSync(${JSON.stringify(canary)},'utf8'),safe:!['OFFCKB_TEST_SECRET','SSH_AUTH_SOCK','NODE_OPTIONS','NODE_PATH','HTTP_PROXY'].some(key=>process.env[key]!==undefined)&&!JSON.stringify(c).includes('rpc-canary')}));
  if(process.argv.includes('fail'))process.exitCode=7;
}`,
  );
  await invoke(['plugin', 'link', probe]);
  const listed = JSON.parse((await invoke(['--json', 'plugin', 'list'])).stdout);
  assert.equal(listed.plugins[0].mode, 'sandbox');
  assert.match((await invoke(['trusted-probe'], 1)).stderr, /refusing unsandboxed/i);
  assert.equal(fs.existsSync(path.join(home, 'trusted-probe.running')), false);
  const linked = await invoke(['--json', 'plugin', 'link', probe, '--trust']);
  assert.equal(JSON.parse(linked.stdout).mode, 'trusted');
  assert.match(linked.stderr, /without OS isolation/);
  const args = ['path with spaces', '--json', '--', '$literal', '& literal'];
  const result = JSON.parse((await invoke(['--json', 'trusted-probe', '--', ...args])).stdout);
  assert.deepEqual(result.args, args);
  assert.equal(result.cwd, fs.realpathSync(probe));
  assert.equal(result.invocation, project.replace(/[\\/]$/, ''));
  assert.equal(result.backend, 'none');
  assert.equal(result.rpc, '');
  assert.equal(result.output, 'json');
  assert.equal(result.safe, true);
  assert.equal(result.canary, 'trusted mode has user file access'); // Never claim a file-access sandbox.
  assert.equal(fs.existsSync(result.context), false);
  assert.equal(fs.existsSync(result.tmp), false);
  await invoke(['trusted-probe', 'fail'], 7);
  fs.writeFileSync(settings, '{broken');
  assert.deepEqual(JSON.parse((await invoke(['trusted-probe', '--help'])).stdout), { help: true, context: null });
  fs.writeFileSync(settings, config);
  console.log(
    'PASS: explicit trust, unavailable-sandbox refusal, real argv/cwd, safe environment, offline help and cleanup',
  );

  const reader = plugin(
    'trusted-reader',
    `const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
(async()=>{const call=method=>fetch(c.devnet.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
console.log(JSON.stringify({read:(await call('get_tip_block_number')).status,write:(await call('send_transaction')).status,safe:!JSON.stringify(c).includes('rpc-canary')}));})().catch(error=>{console.error(error);process.exitCode=1;});`,
    ['devnet-read'],
  );
  assert.match((await invoke(['plugin', 'link', reader, '--trust'], 1)).stderr, /explicit grants/);
  await invoke(['plugin', 'link', reader, '--trust', '--allow', 'devnet-read']);
  assert.deepEqual(JSON.parse((await invoke(['--json', 'trusted-reader'])).stdout), {
    read: 200,
    write: 403,
    safe: true,
  });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].authorization, `Basic ${Buffer.from('user:rpc-canary').toString('base64')}`);
  await invoke(['plugin', 'unlink', 'trusted-reader']);
  console.log(
    'PASS: trusted mode retains capability checks and read-RPC broker without disclosing upstream authentication',
  );

  const web = plugin(
    'trusted-web',
    `const fs=require('fs'),net=require('net'),http=require('http'),cp=require('child_process');
const c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT,'utf8'));
if(c.sandbox.http.transport!=='tcp-v1')throw new Error('wrong transport');
const descendant=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const server=http.createServer((req,res)=>res.end('trusted web fixture'));
let ready=false;
function connect(){
  const endpoint=new URL('tcp://'+c.sandbox.http.endpoint);
  const socket=net.connect({host:endpoint.hostname,port:Number(endpoint.port)},()=>socket.write('offckb-http/1 '+c.sandbox.http.token+'\\n'));
  socket.on('error',()=>socket.destroy());socket.once('close',()=>setTimeout(connect,20));
  let ack=Buffer.alloc(0);
  const authenticate=data=>{
    ack=Buffer.concat([ack,data]);const end=ack.indexOf(10);
    if(end<0){if(ack.length>3)socket.destroy();return;}
    if(end!==2||ack.subarray(0,3).toString()!=='OK\\n'){socket.destroy();return;}
    socket.removeListener('data',authenticate);socket.pause();server.emit('connection',socket);
    if(ack.length>3)socket.unshift(ack.subarray(3));socket.resume();
    if(!ready){ready=true;console.log(JSON.stringify({url:c.sandbox.http.url,rpc:c.devnet.rpcUrl,descendant:descendant.pid}));}
  };
  socket.on('data',authenticate);
}
connect();connect();`,
    ['serve'],
  );
  await invoke(['plugin', 'link', web, '--trust', '--allow', 'serve']);
  const serving = start(['--json', '--plugin-port', '0', 'trusted-web']);
  let descendant;
  try {
    const deadline = Date.now() + 15000;
    while (!serving.stdout.includes('\n')) {
      if (serving.code !== undefined || Date.now() >= deadline)
        throw new Error(serving.stderr || 'Trusted web fixture did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const ready = JSON.parse(serving.stdout);
    descendant = ready.descendant;
    assert.equal(ready.rpc, '');
    const response = await fetch(ready.url, { signal: AbortSignal.timeout(5000) });
    assert.equal(await response.text(), 'trusted web fixture');
    assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
    assert.match((await invoke(['plugin', 'unlink', 'trusted-web'], 1)).stderr, /running/);
  } finally {
    serving.child.send('SIGINT'); // Exercise the host's Ctrl+C handler, including native Windows taskkill /T.
    const timer = setTimeout(() => serving.child.kill('SIGKILL'), 10000);
    try {
      assert.equal(await serving.closed, 130, serving.stderr);
    } finally {
      clearTimeout(timer);
    }
  }
  assert.equal(serving.stdout.trim().split('\n').length, 1);
  const stoppedBy = Date.now() + 3000;
  while (Date.now() < stoppedBy) {
    try {
      process.kill(descendant, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
  assert.equal(fs.existsSync(path.join(home, 'trusted-web.running')), false);
  await invoke(['plugin', 'unlink', 'trusted-web']);
  const manifest = path.join(probe, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  pkg.version = '1.1.0';
  fs.writeFileSync(manifest, JSON.stringify(pkg));
  assert.match((await invoke(['trusted-probe'], 1)).stderr, /identity changed/);
  await invoke(['plugin', 'unlink', 'trusted-probe']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), []);
  console.log(
    'PASS: native trusted HTTP, host security headers, interrupt/tree cleanup, leases and update reauthorization',
  );
} finally {
  for (const running of active) running.child.kill('SIGKILL');
  rpc.closeAllConnections();
  rpc.close();
  fs.rmSync(root, { recursive: true, force: true });
}
