// Copy a user-supplied checkout, keeping the original upstream tree untouched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pinnedCommit = '477af4400a716353d140fc1a5b8fee8175f74fed';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/prepare-explorer-prototype.mjs <pinned-upstream-directory>');
const target = fileURLToPath(new URL('../.prototype/explorer/', import.meta.url));
if (fs.existsSync(target))
  throw new Error(`Destination already exists; review/remove it before preparing again: ${target}`);
const git = (args) =>
  execFileSync('git', ['-C', source, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
let head;
let status;
try {
  head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  status = git(['status', '--porcelain', '--untracked-files=all']);
} catch {
  throw new Error(`Expected a clean Git checkout at commit ${pinnedCommit}`);
}
if (head !== pinnedCommit || status !== '') throw new Error(`Expected a clean Git checkout at commit ${pinnedCommit}`);
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (pkg.name !== 'ckb-devnet-explorer' || pkg.version !== '0.2.0')
  throw new Error(`Expected ckb-devnet-explorer 0.2.0 at commit ${pinnedCommit}`);
let server = fs.readFileSync(path.join(source, 'src/server.ts'), 'utf8');
const signature = 'projects: string[])';
const listen = 'server.listen(port, () => console.log(';
if (!server.includes(signature) || !server.includes(listen))
  throw new Error('Upstream server changed; review the experimental adapter instead of patching blindly');
server = server
  .replace(signature, 'projects: string[], host = "127.0.0.1")')
  .replace(listen, 'server.listen(port, host, () => console.error(');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(source, 'src'), path.join(target, 'src'), { recursive: true });
// A runtime-only manifest avoids installing upstream development tools or running its scripts.
fs.writeFileSync(
  path.join(target, 'package.json'),
  JSON.stringify(
    { name: 'offckb-explorer-prototype-runtime', private: true, type: 'module', dependencies: pkg.dependencies },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(target, 'src/server.ts'), server);
fs.writeFileSync(
  path.join(target, '.offckb-prototype.json'),
  JSON.stringify({ apiVersion: 1, upstreamCommit: pinnedCommit }),
);
console.log(
  `Prepared experimental source at ${target}. Install its runtime dependencies with scripts disabled; see docs/plugins.md.`,
);
