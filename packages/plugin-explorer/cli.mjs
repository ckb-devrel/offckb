import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(
    'Usage: offckb [--plugin-port <port>] explorer [--project <directory>]...\nRequires the public Devnet Explorer CLI integration API v1.',
  );
  process.exit(0);
}

let json = false;
let child;
try {
  const context = JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT, 'utf8'));
  json = context.output === 'json';
  if (context.apiVersion !== 1 || !context.sandbox?.http)
    throw new Error('A sandboxed offckb context with HTTP serving is required');
  if (
    context.devnet.kind !== 'pure-devnet' ||
    context.devnet.addressPrefix !== 'ckt' ||
    !context.devnet.systemScriptsFile
  )
    throw new Error('Explorer requires an initialized ordinary devnet; forks and unknown chains are unsupported');
  const { values } = parseArgs({ args, options: { project: { type: 'string', multiple: true } } });
  const projects = (values.project ?? [context.cwd]).map((file) => {
    try {
      return fs.realpathSync(path.resolve(context.cwd, file));
    } catch {
      throw new Error(
        'Project path is unavailable in the sandbox; use a canonical path and grant its deployment directory',
      );
    }
  });
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('ckb-devnet-explorer/package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (pkg.name !== 'ckb-devnet-explorer' || pkg.version !== '0.3.0')
    throw new Error('Expected ckb-devnet-explorer 0.3.0');
  const root = fs.realpathSync(path.dirname(manifest));
  const bin = fs.realpathSync(path.resolve(root, pkg.bin['ckb-devnet-explorer']));
  if (!bin.startsWith(root + path.sep) || !fs.statSync(bin).isFile())
    throw new Error('Invalid Explorer public CLI entry');
  const info = JSON.parse(
    execFileSync(process.execPath, [bin, '--integration-info'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (
    info.apiVersion !== 1 ||
    !['system-scripts', 'host', 'bridge', 'json-ready'].every((value) => info.capabilities?.includes(value))
  )
    throw new Error('Explorer does not provide the required public CLI integration contract');
  const rpc = async (method, params = []) => {
    const response = await fetch(context.devnet.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(`Devnet RPC ${method} is unavailable`);
    return result.result;
  };
  if ((await rpc('get_block_hash', ['0x0'])) !== context.devnet.genesisHash)
    throw new Error('RPC genesis does not match the supplied scripts');
  const tip = BigInt(await rpc('get_tip_block_number'));
  let indexerReady = false;
  try {
    indexerReady = BigInt((await rpc('get_indexer_tip')).block_number) >= tip;
  } catch {
    /* Report separately. */
  }
  if (!indexerReady) console.error('Indexer is missing or behind; some queries may be incomplete');
  child = spawn(
    process.execPath,
    [
      bin,
      'serve',
      '--json',
      '--rpc',
      context.devnet.rpcUrl,
      '--system-scripts',
      context.devnet.systemScriptsFile,
      '--bridge',
      context.sandbox.http.socket,
      ...projects.flatMap((directory) => ['--project', directory]),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let requested;
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])
    process.once(signal, () => {
      requested = code;
      child.kill(signal);
    });
  let count = 0;
  let buffer = '';
  let invalid = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 65536) {
      invalid = true;
      child.kill('SIGTERM');
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const ready = JSON.parse(line);
        if (++count !== 1 || ready.ok !== true || ready.apiVersion !== 1 || ready.transport !== 'bridge')
          throw new Error('Unexpected ready record');
        if (json)
          console.log(JSON.stringify({ ok: true, command: 'explorer', url: context.sandbox.http.url, indexerReady }));
        else console.error(`Explorer: ${context.sandbox.http.url}`);
      } catch {
        invalid = true;
        child.kill('SIGTERM');
      }
    }
  });
  const exit = await closed;
  if (invalid || count !== 1 || buffer.trim()) throw new Error('Explorer violated its public ready/output contract');
  process.exitCode = requested ?? exit.code ?? 1;
} catch (error) {
  child?.kill('SIGTERM');
  const message =
    error.code === 'MODULE_NOT_FOUND' ? 'Install the pinned Explorer provider; see the plugin README' : error.message;
  console.error(json ? JSON.stringify({ ok: false, code: 'EXPLORER_FAILED', message }) : message);
  process.exitCode = 1;
}
