import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { nodesYmlPath } from '../src/fiber/paths';
import { ensureNodesYml, readNodesYml, validateNodeCount } from '../src/fiber/nodes-yml';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function fixture(): Settings {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-nodes-'));
  tempRoots.push(root);
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.configPath = path.join(root, 'devnet');
  return settings;
}

describe('validateNodeCount', () => {
  it('accepts 1-16 and rejects everything else', () => {
    expect(validateNodeCount(1)).toBe(1);
    expect(validateNodeCount(16)).toBe(16);
    expect(() => validateNodeCount(0)).toThrow('between 1 and 16');
    expect(() => validateNodeCount(17)).toThrow('between 1 and 16');
    expect(() => validateNodeCount(2.5)).toThrow('between 1 and 16');
  });
});

describe('ensureNodesYml', () => {
  it('creates two nodes by default', () => {
    const settings = fixture();
    const entries = ensureNodesYml(undefined, settings);
    expect(entries).toEqual([
      { id: 1, config: {} },
      { id: 2, config: {} },
    ]);
    expect(fs.existsSync(nodesYmlPath(settings))).toBe(true);
  });

  it('creates the requested number of nodes on first start', () => {
    const settings = fixture();
    const entries = ensureNodesYml(4, settings);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('keeps per-node config when growing and warns when shrinking', () => {
    const settings = fixture();
    ensureNodesYml(3, settings);
    const file = nodesYmlPath(settings);
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as { nodes: { id: number; config: object }[] };
    doc.nodes[1].config = { fiber: { auto_accept_channel_ckb_funding_amount: 99 } };
    fs.writeFileSync(file, yaml.dump(doc));

    const grown = ensureNodesYml(4, settings);
    expect(grown.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(grown[1].config).toEqual({ fiber: { auto_accept_channel_ckb_funding_amount: 99 } });
    expect(grown[3].config).toEqual({});

    const shrunk = ensureNodesYml(2, settings);
    expect(shrunk.map((e) => e.id)).toEqual([1, 2]);
    expect(shrunk[1].config).toEqual({ fiber: { auto_accept_channel_ckb_funding_amount: 99 } });
  });

  it('uses the stored list when no count is requested', () => {
    const settings = fixture();
    ensureNodesYml(5, settings);
    const entries = ensureNodesYml(undefined, settings);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('readNodesYml', () => {
  it('returns null when the file does not exist', () => {
    expect(readNodesYml(fixture())).toBeNull();
  });

  it('rejects duplicate ids', () => {
    const settings = fixture();
    fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
    fs.writeFileSync(nodesYmlPath(settings), yaml.dump({ nodes: [{ id: 1 }, { id: 1 }] }));
    expect(() => readNodesYml(settings)).toThrow('duplicate node id 1');
  });

  it('rejects an empty node list', () => {
    // An empty stored list must not bypass the minimum-node constraint that
    // validateNodeCount enforces for the --nodes flag.
    const settings = fixture();
    fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
    fs.writeFileSync(nodesYmlPath(settings), yaml.dump({ nodes: [] }));
    expect(() => readNodesYml(settings)).toThrow('at least 1 node must be configured');
  });

  it('rejects managed config fields', () => {
    const settings = fixture();
    fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
    fs.writeFileSync(
      nodesYmlPath(settings),
      yaml.dump({ nodes: [{ id: 1, config: { fiber: { chain: 'evil.toml' } } }] }),
    );
    expect(() => readNodesYml(settings)).toThrow('fiber.chain');
  });

  it('rejects a per-node fiber.store_path override', () => {
    // A relocated store would make clean's RocksDB LOCK check watch the wrong
    // path, silently dropping its fail-closed property.
    const settings = fixture();
    fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
    fs.writeFileSync(
      nodesYmlPath(settings),
      yaml.dump({ nodes: [{ id: 1, config: { fiber: { store_path: '/tmp/elsewhere' } } }] }),
    );
    expect(() => readNodesYml(settings)).toThrow('fiber.store_path');
  });

  it('rejects managed rpc and ckb fields', () => {
    const settings = fixture();
    fs.mkdirSync(path.dirname(nodesYmlPath(settings)), { recursive: true });
    fs.writeFileSync(
      nodesYmlPath(settings),
      yaml.dump({ nodes: [{ id: 1, config: { rpc: { listening_addr: '0.0.0.0:1' } } }] }),
    );
    expect(() => readNodesYml(settings)).toThrow('rpc.listening_addr');

    fs.writeFileSync(nodesYmlPath(settings), yaml.dump({ nodes: [{ id: 1, config: { services: ['cch'] } }] }));
    expect(() => readNodesYml(settings)).toThrow('services');
  });
});
