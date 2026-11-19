// Exercise native entries through the production bundle. No public service or user configuration is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'build/index.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offckb binary smoke ')));
const sandbox = process.argv.includes('--sandbox');
const archiveIndex = process.argv.indexOf('--ckb-cli-archive');
const archive = archiveIndex === -1 ? undefined : path.resolve(process.argv[archiveIndex + 1]);
const realCkbCli = archive !== undefined || process.argv.includes('--ckb-cli');
const env = {
  ...process.env,
  OFFCKB_PLUGIN_HOME: path.join(root, 'plugins'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  APPDATA: path.join(root, 'appdata'),
  LOCALAPPDATA: path.join(root, 'localappdata'),
  OFFCKB_TEST_SECRET: 'must-not-inherit',
};
const worker =
  `require('os').homedir=()=>${JSON.stringify(root)};` +
  (archive
    ? `const realFetch=global.fetch;global.fetch=async(input,options)=>options?.method==='POST'?realFetch(input,options):new Response(require('fs').readFileSync(${JSON.stringify(archive)}));`
    : '') +
  `process.argv=[process.execPath,${JSON.stringify(cli)},...process.argv.slice(1)];require(${JSON.stringify(cli)}).runCli(process.argv);`;
async function invoke(args, expected = 0) {
  const child = spawn(process.execPath, ['-e', worker, '--', ...args], {
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
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, expected, stderr + '\n' + stdout + '\nUpstream methods: ' + JSON.stringify(calls));
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
const calls = [];
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const call = JSON.parse(raw);
  calls.push(call.method);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: '0x2a' }));
});
try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config =
    process.platform === 'darwin'
      ? path.join(root, 'Library/Preferences/offckb-nodejs/settings.json')
      : process.platform === 'win32'
        ? path.join(env.APPDATA, 'offckb-nodejs/Config/settings.json')
        : path.join(env.XDG_CONFIG_HOME, 'offckb-nodejs/settings.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ devnet: { rpcUrl: `http://127.0.0.1:${upstream.address().port}` } }));
  const mode = sandbox ? [] : ['--trust'];
  if (realCkbCli) {
    await invoke(['plugin', 'install', 'tool:ckb-cli', ...mode, '--allow', 'devnet-read']);
    assert.match((await invoke(['ckb-cli', '--help'])).stdout, /ckb-cli 2\.0\.0/i);
    const result = await invoke(['ckb-cli', '--local-only', '--output-format', 'json', 'rpc', 'get_tip_block_number']);
    assert.equal(JSON.parse(result.stdout), 42);
    assert.ok(calls.includes('get_tip_block_number'));
    // Read broker stays read-only even when trusted execution was chosen.
    const denied = await invoke(['ckb-cli', '--local-only', 'rpc', 'clear_banned_addresses'], 1);
    assert.match(denied.stderr, /http error|403/i);
    assert.ok(!calls.includes('clear_banned_addresses'));
    await invoke(['plugin', 'remove', 'ckb-cli']);
    console.log(
      `PASS: pinned official ckb-cli install/help/read RPC/write denial/remove (${sandbox ? 'sandbox' : 'trusted'})`,
    );
  } else {
    const directory = path.join(root, 'native probe');
    fs.mkdirSync(directory);
    const entry = process.platform === 'win32' ? 'node.exe' : 'node';
    fs.copyFileSync(process.execPath, path.join(directory, entry));
    fs.chmodSync(path.join(directory, entry), 0o755);
    const secret = path.join(root, 'secret');
    fs.writeFileSync(secret, 'host-canary');
    const code = `const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT));
      (async()=>{const call=method=>fetch(process.env.TOOL_RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
      const read=await call('get_tip_block_number');const write=await call('send_transaction');
      let denied=false;try{fs.readFileSync(${JSON.stringify(secret)})}catch{denied=true}
      fs.writeFileSync(process.env.TOOL_HOME+'/saved','persistent');
      console.log(JSON.stringify({args:process.argv.slice(2),read:await read.json(),write:write.status,
        secretFiltered:!process.env.OFFCKB_TEST_SECRET,denied,home:process.env.TOOL_HOME===c.plugin.dataPath}));})();`;
    fs.writeFileSync(path.join(directory, 'probe.cjs'), code);
    fs.writeFileSync(
      path.join(directory, 'offckb-tool.json'),
      JSON.stringify({
        apiVersion: 1,
        name: 'native-probe',
        version: '1.0.0',
        command: 'native-probe',
        entry,
        description: 'Native probe',
        permissions: ['devnet-read'],
        execution: {
          args: [path.join(directory, 'probe.cjs')],
          env: { TOOL_HOME: '${plugin.dataPath}', TOOL_RPC: '${devnet.rpcUrl}' },
        },
      }),
    );
    await invoke(['plugin', 'link', directory, ...mode, '--allow', 'devnet-read']);
    assert.match((await invoke(['native-probe', '--help'])).stdout, /Usage:/i);
    const result = JSON.parse((await invoke(['native-probe', 'a b', '--', '$literal'])).stdout);
    assert.deepEqual(result.args, ['a b', '--', '$literal']);
    assert.equal(result.read.result, '0x2a');
    assert.equal(result.write, 403);
    assert.equal(result.secretFiltered, true);
    assert.equal(result.home, true);
    assert.equal(result.denied, sandbox);
    await invoke(['plugin', 'unlink', 'native-probe']);
    console.log(`PASS: production native argv/context/storage/RPC/permissions (${sandbox ? 'sandbox' : 'trusted'})`);
    if (process.platform !== 'win32') {
      fs.writeFileSync(
        path.join(directory, 'probe.cjs'),
        `const fs=require('fs');if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(2);process.stdin.setRawMode(true);process.stdin.setRawMode(false);console.log('NATIVE_TTY_OK');`,
      );
      await invoke(['plugin', 'link', directory, ...mode, '--allow', 'devnet-read']);
      const python = `import os,pty,subprocess,select,time,sys\nm,s=pty.openpty()\np=subprocess.Popen(sys.argv[1:],stdin=s,stdout=s,stderr=s)\nos.close(s)\ndata=b''\nend=time.time()+25\nwhile time.time()<end:\n if select.select([m],[],[],0.1)[0]:\n  try: data+=os.read(m,65536)\n  except OSError: break\n if p.poll() is not None: break\nif p.poll() is None: p.kill()\np.wait()\nos.close(m)\nsys.stdout.buffer.write(data)\nsys.exit(0 if p.returncode==0 and b'NATIVE_TTY_OK' in data else 1)`;
      const child = spawn('python3', ['-c', python, process.execPath, '-e', worker, '--', 'native-probe'], { env });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, output);
      await invoke(['plugin', 'unlink', 'native-probe']);
      console.log(`PASS: real PTY inherited by native entry; raw-mode ioctl (${sandbox ? 'sandbox' : 'trusted'})`);
    }
  }
} finally {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
