import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';
import { cachePath, getCKBBinaryPath, packageRootPath, readSettings } from '../cfg/setting';
import { installCKBBinary } from '../node/install';
import { isFolderExists } from '../util/fs';
import { Request } from '../util/request';
import { logger } from '../util/logger';
import { MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, identifyPublicChainByGenesisHash } from '../scripts/const';

export type ForkSource = 'mainnet' | 'testnet' | 'custom';

export interface ForkState {
  source: ForkSource;
  sourceDir: string;
  ckbVersion: string;
  genesisHash: string;
  forkedAt: string;
  firstRunPending: boolean;
}

export interface ForkOptions {
  from: string;
  source?: 'mainnet' | 'testnet';
  specFile?: string;
  force?: boolean;
}

export const FORK_STATE_FILE = 'fork.json';

// The official guide requires genesis_epoch_length to stay at 1743 for a
// mainnet fork, and to fall back to the default 1000 for a testnet fork
// (i.e. the key must be absent). Getting this wrong produces a different
// genesis hash and the node refuses to start. See nervosnetwork/ckb#5205.
const MAINNET_GENESIS_EPOCH_LENGTH = 1743;

export function getForkStatePath(configPath: string): string {
  return path.join(configPath, FORK_STATE_FILE);
}

export function readForkState(configPath: string): ForkState | null {
  const statePath = getForkStatePath(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ForkState>;
    if (typeof parsed.source !== 'string' || typeof parsed.firstRunPending !== 'boolean') {
      return null;
    }
    return parsed as ForkState;
  } catch {
    return null;
  }
}

export function writeForkState(configPath: string, state: ForkState): void {
  const statePath = getForkStatePath(configPath);
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, statePath);
}

export function markForkFirstRunComplete(configPath: string): void {
  const state = readForkState(configPath);
  if (!state || !state.firstRunPending) return;
  writeForkState(configPath, { ...state, firstRunPending: false });
}

export function detectSourceFromCkbToml(ckbTomlContent: string): 'mainnet' | 'testnet' | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = toml.parse(ckbTomlContent) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const chain = parsed.chain;
  if (chain == null || typeof chain !== 'object') return null;
  const spec = (chain as Record<string, unknown>).spec;
  if (spec == null || typeof spec !== 'object') return null;
  const bundled = (spec as Record<string, unknown>).bundled;
  if (typeof bundled !== 'string') return null;
  if (bundled.includes('mainnet')) return 'mainnet';
  if (bundled.includes('testnet')) return 'testnet';
  return null;
}

export function parseGenesisHashFromInitOutput(output: string): string | null {
  const match = output.match(/Genesis Hash:\s*(0x[0-9a-fA-F]{64})/);
  return match ? match[1].toLowerCase() : null;
}

// `ckb list-hashes` prints TOML with a single table whose `genesis` field is
// the chain's genesis hash.
export function parseGenesisHashFromListHashes(output: string): string | null {
  const match = output.match(/^\s*genesis\s*=\s*"(0x[0-9a-fA-F]{64})"\s*$/m);
  return match ? match[1].toLowerCase() : null;
}

export function expectedGenesisHash(source: 'mainnet' | 'testnet'): string {
  return source === 'mainnet' ? MAINNET_GENESIS_HASH : TESTNET_GENESIS_HASH;
}

// Patch the imported chain spec into a minable dev chain, following
// https://docs.nervos.org/docs/node/devnet-from-existing-data
export function patchDevSpecForFork(spec: Record<string, unknown>, source: ForkSource): Record<string, unknown> {
  const pow = { ...((spec.pow as Record<string, unknown>) ?? {}), func: 'Dummy' };

  const params = { ...((spec.params as Record<string, unknown>) ?? {}) };
  params.cellbase_maturity = 0;
  params.permanent_difficulty_in_dummy = true;
  if (source === 'mainnet') {
    params.genesis_epoch_length = MAINNET_GENESIS_EPOCH_LENGTH;
  } else if (source === 'testnet') {
    // testnet derives genesis_epoch_length from the default (1000); a leftover
    // mainnet value here is exactly the nervosnetwork/ckb#5205 trap.
    delete params.genesis_epoch_length;
  }
  // custom specs keep whatever genesis_epoch_length they declared

  return { ...spec, pow, params };
}

function validateSourceDir(sourceDir: string): void {
  if (!isFolderExists(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  if (!isFolderExists(path.join(sourceDir, 'data', 'db'))) {
    throw new Error(
      `${sourceDir} does not look like a CKB node directory (missing data/db). ` +
        `Point --from at the directory the source node runs with (-C).`,
    );
  }
}

// Best-effort detection of a running ckb process using the given directory.
// Returns null when the check cannot be performed (Windows, no ps).
function isCkbNodeRunningOn(dir: string): boolean | null {
  if (process.platform === 'win32') return null;
  let processes = '';
  try {
    processes = execSync('ps -eo args', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  return processes.split('\n').some((line) => {
    const tokens = line.trim().split(/\s+/);
    // The program itself must be a ckb binary — a looser match would flag
    // unrelated processes that merely mention the directory.
    const program = path.basename(tokens[0] ?? '');
    if (program !== 'ckb' && program !== 'ckb.exe') return false;
    return tokens.includes('run') && line.includes(dir);
  });
}

function assertSourceNodeStopped(sourceDir: string): void {
  const running = isCkbNodeRunningOn(sourceDir);
  if (running === null) {
    logger.warn('Make sure the source CKB node is stopped; copying a live database produces corrupted data.');
    return;
  }
  if (running) {
    throw new Error(
      `A CKB node appears to be running on ${sourceDir}. Stop it first; ` +
        `copying a live database produces corrupted data.`,
    );
  }
}

function assertOffckbDevnetStopped(): void {
  const settings = readSettings();

  // Foreground `offckb node` (no daemon pid file): look for the ckb process.
  if (isCkbNodeRunningOn(settings.devnet.configPath) === true) {
    throw new Error('An offckb devnet node appears to be running. Stop it before forking.');
  }

  // Daemon mode: check the pid file.
  const pidFile = path.join(settings.devnet.dataPath, 'logs', 'daemon.pid');
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    return;
  }
  let pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      pid = Number((JSON.parse(raw) as { pid?: number }).pid);
    } catch {
      return;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return;

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false; // ESRCH: stale pid file, no daemon running
  }
  if (alive) {
    throw new Error(`The offckb devnet daemon is running (PID ${pid}). Stop it first with: offckb node stop`);
  }
}

async function resolveSpecFile(
  options: ForkOptions,
  source: 'mainnet' | 'testnet',
  ckbVersion: string,
): Promise<string> {
  if (options.specFile) {
    const specFile = path.resolve(options.specFile);
    if (!fs.existsSync(specFile)) {
      throw new Error(`Spec file not found: ${specFile}`);
    }
    return specFile;
  }

  const cacheDir = path.join(cachePath, 'specs', ckbVersion);
  const cachedSpec = path.join(cacheDir, `${source}.toml`);
  if (fs.existsSync(cachedSpec)) {
    logger.debug(`Using cached ${source} spec: ${cachedSpec}`);
    return cachedSpec;
  }

  const url = `https://raw.githubusercontent.com/nervosnetwork/ckb/v${ckbVersion}/resource/specs/${source}.toml`;
  logger.info(`Downloading ${source} chain spec from ${url} ..`);
  try {
    const response = await Request.send(url);
    const content = await response.text();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachedSpec, content);
    return cachedSpec;
  } catch (error) {
    throw new Error(
      `Failed to download the ${source} chain spec for CKB v${ckbVersion}: ${(error as Error).message}. ` +
        `Pass a local copy with --spec-file.`,
    );
  }
}

function copySourceData(sourceDir: string, configPath: string): void {
  const sourceData = path.join(sourceDir, 'data');
  const targetData = path.join(configPath, 'data');
  logger.info(`Copying chain data from ${sourceData} to ${targetData} ..`);
  logger.info('This can take a while for large chains.');
  fs.mkdirSync(configPath, { recursive: true });
  // Full copy on purpose: never hardlink — RocksDB appends to WAL/MANIFEST in
  // place, and linked files would corrupt the source chain.
  fs.cpSync(sourceData, targetData, { recursive: true });
}

function runCkbInit(ckbBinPath: string, configPath: string, specFile: string): string {
  // argv form, never a shell: --spec-file is user input and quote-wrapping
  // alone does not stop shell expansion (command substitution still runs
  // inside double quotes).
  const args = ['init', '-C', configPath, '--chain', 'dev', '--import-spec', specFile, '--force'];
  logger.debug(`Running: ${ckbBinPath} ${args.join(' ')}`);
  return execFileSync(ckbBinPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// Best-effort read of the source directory's own chain identity. `ckb
// list-hashes` resolves the chain spec of the given config dir (no database
// access needed), which tells us which chain the source node was configured
// for. Returns null when the source is not a standard config dir.
function readSourceGenesisHash(ckbBinPath: string, sourceDir: string): string | null {
  try {
    const output = execFileSync(ckbBinPath, ['list-hashes', '-C', sourceDir], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGenesisHashFromListHashes(output);
  } catch {
    return null;
  }
}

// Overwrite the ckb-init-generated configs with offckb's own devnet configs so
// the fork behaves like a normal offckb devnet (miner account as block
// assembler, RPC on 8114 with the Indexer module, proxy on 28114). The
// imported specs/dev.toml is kept.
function alignConfigsWithOffckb(configPath: string): void {
  const settings = readSettings();
  const devnetSourcePath = path.resolve(packageRootPath, './ckb/devnet');

  fs.copyFileSync(path.join(devnetSourcePath, 'ckb.toml'), path.join(configPath, 'ckb.toml'));
  fs.copyFileSync(path.join(devnetSourcePath, 'default.db-options'), path.join(configPath, 'default.db-options'));

  const minerToml = fs.readFileSync(path.join(devnetSourcePath, 'ckb-miner.toml'), 'utf8');
  fs.writeFileSync(
    path.join(configPath, 'ckb-miner.toml'),
    minerToml.replace('http://ckb:8114/', settings.devnet.rpcUrl),
  );
}

export async function forkDevnet(options: ForkOptions): Promise<void> {
  const settings = readSettings();
  const configPath = settings.devnet.configPath;
  const ckbVersion = settings.bins.defaultCKBVersion;

  const sourceDir = path.resolve(options.from);
  validateSourceDir(sourceDir);
  assertSourceNodeStopped(sourceDir);
  assertOffckbDevnetStopped();

  if (isFolderExists(configPath)) {
    if (!options.force) {
      throw new Error(
        `A devnet already exists at ${configPath}. Re-run with --force to replace it, ` +
          `or reset it first with: offckb clean`,
      );
    }
    logger.info(`Removing existing devnet at ${configPath} ..`);
    fs.rmSync(configPath, { recursive: true, force: true });
  }

  // Identify the source chain: explicit flag > ckb.toml bundled spec.
  let source: ForkSource | null = options.source ?? null;
  if (source == null) {
    const sourceCkbToml = path.join(sourceDir, 'ckb.toml');
    if (fs.existsSync(sourceCkbToml)) {
      source = detectSourceFromCkbToml(fs.readFileSync(sourceCkbToml, 'utf8'));
    }
  }
  if (source == null && !options.specFile) {
    throw new Error(
      'Could not identify the source chain from the source directory. ' +
        'Pass --source mainnet|testnet, or provide the chain spec with --spec-file.',
    );
  }

  await installCKBBinary(ckbVersion);
  const ckbBinPath = getCKBBinaryPath(ckbVersion);

  try {
    // Inside the try so a failed copy (disk full, permissions, I/O) gets the
    // same rollback: a partial configPath would otherwise block the next
    // attempt as an "existing devnet".
    copySourceData(sourceDir, configPath);

    const specFile = await resolveSpecFile(options, source ?? 'mainnet', ckbVersion);

    const initOutput = runCkbInit(ckbBinPath, configPath, specFile);
    const genesisHash = parseGenesisHashFromInitOutput(initOutput);
    if (!genesisHash) {
      throw new Error(`Could not parse the genesis hash from ckb init output:\n${initOutput}`);
    }

    // A custom spec may still be a well-known chain; let the chain data
    // self-identify via its genesis hash.
    if (source == null) {
      source = identifyPublicChainByGenesisHash(genesisHash) ?? 'custom';
    }
    if (source !== 'custom') {
      const expected = expectedGenesisHash(source);
      if (genesisHash !== expected) {
        throw new Error(
          `Genesis hash mismatch: expected ${expected} for ${source}, got ${genesisHash}. ` +
            `This usually means the chain spec does not match the source data. ` +
            `(Importing a testnet spec with a CKB older than v0.207.0 sets a wrong genesis_epoch_length, ` +
            `see nervosnetwork/ckb#5205.)`,
        );
      }
    }

    // The genesis above comes from the imported spec alone — it cannot see
    // that --source/--spec-file contradicts the copied data (e.g. a mainnet
    // spec over testnet data would pass and only fail when the node boots).
    // Cross-check the source directory's own configured genesis and reject
    // mismatches now. Skipped (null) when the source is not a standard
    // config dir; the node's boot-time genesis check remains the backstop.
    const sourceGenesisHash = readSourceGenesisHash(ckbBinPath, sourceDir);
    if (sourceGenesisHash && sourceGenesisHash !== genesisHash) {
      throw new Error(
        `The source directory is configured for a different chain (genesis ${sourceGenesisHash}) ` +
          `than the imported spec (genesis ${genesisHash}). Pass a matching --source or --spec-file.`,
      );
    }

    const devSpecPath = path.join(configPath, 'specs', 'dev.toml');
    const spec = toml.parse(fs.readFileSync(devSpecPath, 'utf8')) as unknown as Record<string, unknown>;
    const patched = patchDevSpecForFork(spec, source);
    const tempSpecPath = `${devSpecPath}.tmp`;
    fs.writeFileSync(tempSpecPath, toml.stringify(patched as unknown as JsonMap));
    fs.renameSync(tempSpecPath, devSpecPath);

    alignConfigsWithOffckb(configPath);

    const state: ForkState = {
      source,
      sourceDir,
      ckbVersion,
      genesisHash,
      forkedAt: new Date().toISOString(),
      firstRunPending: true,
    };
    writeForkState(configPath, state);

    logger.success(`Devnet forked from ${sourceDir} (${source}, genesis ${genesisHash}).`);
    logger.info('Start it with: offckb node');
    logger.info('The first run applies --skip-spec-check --overwrite-spec automatically.');
  } catch (error) {
    // Leave no half-forked devnet behind.
    fs.rmSync(configPath, { recursive: true, force: true });
    throw error;
  }
}
