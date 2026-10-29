import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: offckb explorer [--project <directory>]... [--port <0-65535>]\nExperimental adapter: Node 22+, ordinary initialized devnet, prepared upstream source.',
  );
  process.exit(0);
}

let json = false;
try {
  const context = JSON.parse(fs.readFileSync(process.env.OFFCKB_PLUGIN_CONTEXT, 'utf8'));
  json = context.output === 'json';
  if (context.apiVersion !== 1) throw new Error('Unsupported offckb context version');
  if (
    context.devnet.kind !== 'pure-devnet' ||
    context.devnet.addressPrefix !== 'ckt' ||
    !context.devnet.systemScriptsFile
  ) {
    throw new Error(
      'Explorer currently requires an initialized ordinary devnet; forks and unknown chains are unsupported.',
    );
  }
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string', multiple: true },
      port: { type: 'string', default: '7070' },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  const projects = (values.project ?? [context.cwd]).map((directory) => path.resolve(context.cwd, directory));
  // PROTOTYPE-ONLY: remove this override together with private source imports before formal distribution.
  const source = path.resolve(
    process.env.OFFCKB_EXPLORER_SOURCE || fileURLToPath(new URL('../../../.prototype/explorer', import.meta.url)),
  );
  const marker = path.join(source, '.offckb-prototype.json');
  if (!fs.statSync(marker).isFile() || JSON.parse(fs.readFileSync(marker, 'utf8')).apiVersion !== 1) {
    throw new Error('Prepare the pinned Explorer source first; see docs/plugins.md');
  }
  const require = createRequire(path.join(source, 'package.json'));
  const tsxManifest = require.resolve('tsx/package.json');
  const tsx = JSON.parse(fs.readFileSync(tsxManifest, 'utf8'));
  const esmApi = tsx.exports['./esm/api'].import.default;
  const { register } = await import(pathToFileURL(path.resolve(path.dirname(tsxManifest), esmApi)).href);
  register();
  // Deliberately pinned private imports for this experiment, not a published compatibility contract.
  const [{ startServer }, { Explorer }, { Resolver }, { loadProjectScripts }] = await Promise.all(
    ['server', 'explorer', 'resolver', 'scripts'].map(
      (name) => import(pathToFileURL(path.join(source, 'src', `${name}.ts`)).href),
    ),
  );
  const exported = JSON.parse(fs.readFileSync(context.devnet.systemScriptsFile, 'utf8'));
  const known = new Map();
  for (const [name, entry] of Object.entries(exported.devnet)) {
    const script = entry?.script ?? entry;
    if (!script?.codeHash || !script.hashType) continue;
    const dep = script.cellDeps?.[0]?.cellDep;
    known.set(`${script.codeHash.toLowerCase()}:${script.hashType}`, {
      name,
      source: 'genesis',
      codeHash: script.codeHash.toLowerCase(),
      hashType: script.hashType,
      location: dep ? { txHash: dep.outPoint.txHash, index: Number(dep.outPoint.index), depType: dep.depType } : null,
    });
  }
  for (const project of projects) for (const [key, script] of loadProjectScripts(project)) known.set(key, script);
  const rpc = async (method, params = []) => {
    const response = await fetch(context.devnet.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Devnet RPC request failed');
    const result = await response.json();
    if (result.error) throw new Error(`Devnet RPC ${method} is unavailable`);
    return result.result;
  };
  if ((await rpc('get_block_hash', ['0x0'])) !== context.devnet.genesisHash) {
    throw new Error('Configured RPC genesis does not match the offckb devnet context.');
  }
  const tip = BigInt(await rpc('get_tip_block_number'));
  let indexerReady = false;
  try {
    indexerReady = BigInt((await rpc('get_indexer_tip')).block_number) >= tip;
  } catch {
    /* Report separately. */
  }
  if (!indexerReady)
    console.error('CKB indexer is missing or behind; some Explorer queries may fail or be incomplete.');
  const server = startServer(
    new Explorer(context.devnet.rpcUrl, new Resolver(known)),
    port,
    context.devnet.rpcUrl,
    projects,
    '127.0.0.1',
  );
  server.once('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    if (json) console.log(JSON.stringify({ ok: true, command: 'explorer', url, indexerReady }));
    else console.error(`Explorer: ${url}`);
  });
  server.on('error', (error) => {
    console.error(
      json
        ? JSON.stringify({ ok: false, code: 'EXPLORER_SERVER_FAILED', message: error.code || 'Server failed' })
        : `Explorer server failed: ${error.code || 'unknown error'}`,
    );
    process.exitCode = 1;
  });
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.once(signal, () => {
      server.close(() => {
        process.exitCode = code;
      });
      server.closeAllConnections();
    });
  }
} catch (error) {
  const message =
    error.code === 'ENOENT' ? 'Prepared Explorer source or context is missing; see docs/plugins.md' : error.message;
  console.error(json ? JSON.stringify({ ok: false, code: 'EXPLORER_START_FAILED', message }) : message);
  process.exitCode = 1;
}
