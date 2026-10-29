import fs from 'fs';
import os from 'os';
import path from 'path';
import * as settingsModule from '../src/cfg/setting';
import { fiberNodePaths, nodesYmlPath } from '../src/fiber/paths';
import { fiberClean } from '../src/fiber/clean';
import { clean } from '../src/cmd/clean';
import { FiberManifest, newNodeEntry, resolveNodeFile, writeManifest } from '../src/fiber/nodes-yml';
import { confirm } from '@inquirer/prompts';

jest.mock('@inquirer/prompts', () => ({ confirm: jest.fn() }));

it('separates Fiber reset, chain reset and full environment deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-reset-'));
  const settings = structuredClone(settingsModule.defaultSettings);
  settings.devnet.configPath = path.join(root, 'devnet');
  settings.devnet.dataPath = path.join(root, 'devnet/data');
  jest.spyOn(settingsModule, 'readSettings').mockReturnValue(settings);
  const paths = fiberNodePaths(1, settings);
  const keep = [
    paths.ckbKeyFile,
    paths.passwordFile,
    paths.fiberSkFile,
    paths.configFile,
    path.join(paths.dir, 'config.default.yml'),
    path.join(paths.dir, 'biscuit/private.key'),
    path.join(paths.dir, 'biscuit/public.key'),
    path.join(paths.dir, 'rpc-token'),
  ];
  try {
    for (const file of keep) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'keep');
    }
    fs.mkdirSync(paths.fiberStoreDir, { recursive: true });
    fs.writeFileSync(path.join(paths.fiberStoreDir, 'channel'), 'data');
    fs.mkdirSync(settings.devnet.dataPath, { recursive: true });
    fs.writeFileSync(path.join(settings.devnet.dataPath, 'block'), 'data');
    await fiberClean({ data: true, yes: true }, settings);
    expect(fs.existsSync(paths.fiberStoreDir)).toBe(false);
    expect(fs.existsSync(settings.devnet.dataPath)).toBe(true);
    expect(keep.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(keep.map(() => 'keep'));
    fs.mkdirSync(paths.fiberStoreDir, { recursive: true });
    clean({ data: true });
    expect(fs.existsSync(paths.fiberStoreDir)).toBe(false);
    expect(fs.existsSync(settings.devnet.dataPath)).toBe(false);
    expect(keep.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(keep.map(() => 'keep'));
    clean();
    expect(fs.existsSync(settings.devnet.configPath)).toBe(false);
  } finally {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('data reset with custom config and token paths', () => {
  let root: string;
  let settings: settingsModule.Settings;
  let manifest: FiberManifest;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-reset-paths-'));
    settings = structuredClone(settingsModule.defaultSettings);
    settings.devnet.configPath = path.join(root, 'devnet');
    settings.devnet.dataPath = path.join(settings.devnet.configPath, 'data');
    jest.spyOn(settingsModule, 'readSettings').mockReturnValue(settings);
    manifest = { nodes: [newNodeEntry(1), newNodeEntry(2)] };
    for (const node of manifest.nodes) {
      for (const field of ['config_file', 'rpc_token_file'] as const) {
        const file = resolveNodeFile(node[field], settings);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `keep ${field}`);
      }
      const store = fiberNodePaths(node.id, settings).fiberStoreDir;
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'channel'), 'keep channel');
    }
    fs.mkdirSync(settings.devnet.dataPath, { recursive: true });
    fs.writeFileSync(path.join(settings.devnet.dataPath, 'block'), 'keep block');
    writeManifest(manifest, settings);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function moveFile(field: 'config_file' | 'rpc_token_file', file: string) {
    const node = manifest.nodes[0];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(resolveNodeFile(node[field], settings), file);
    node[field] = path.relative(path.dirname(nodesYmlPath(settings)), file);
    writeManifest(manifest, settings);
  }

  function expectAllDataKept() {
    expect(fs.readFileSync(path.join(settings.devnet.dataPath, 'block'), 'utf8')).toBe('keep block');
    for (const node of manifest.nodes) {
      expect(fs.readFileSync(path.join(fiberNodePaths(node.id, settings).fiberStoreDir, 'channel'), 'utf8')).toBe(
        'keep channel',
      );
      for (const field of ['config_file', 'rpc_token_file'] as const) {
        expect(fs.readFileSync(resolveNodeFile(node[field], settings), 'utf8')).toBe(`keep ${field}`);
      }
    }
  }

  async function reset(command: 'fiber' | 'devnet') {
    if (command === 'fiber') await fiberClean({ data: true, yes: true }, settings);
    else clean({ data: true });
  }

  describe.each(['fiber', 'devnet'] as const)('%s data-only reset', (command) => {
    it.each(['config_file', 'rpc_token_file'] as const)(
      'refuses %s in another node store before deleting any data',
      async (field) => {
        moveFile(field, path.join(fiberNodePaths(2, settings).fiberStoreDir, field));
        await expect(reset(command)).rejects.toThrow(`Fiber node 1 ${field}`);
        expectAllDataKept();
      },
    );

    it('detects a retained file reached through a directory link', async () => {
      const target = fiberNodePaths(2, settings).fiberStoreDir;
      moveFile('config_file', path.join(target, 'config.yml'));
      const alias = path.join(root, 'store-link');
      fs.symlinkSync(target, alias, 'junction');
      manifest.nodes[0].config_file = path.join(alias, 'config.yml');
      writeManifest(manifest, settings);
      await expect(reset(command)).rejects.toThrow('Fiber node 1 config_file');
      expectAllDataKept();
    });

    it('allows custom files beside the store and preserves their contents', async () => {
      const directory = `${fiberNodePaths(1, settings).fiberStoreDir}-keep`;
      moveFile('config_file', path.join(directory, 'custom.yml'));
      moveFile('rpc_token_file', path.join(directory, 'custom-token'));
      await reset(command);
      for (const node of manifest.nodes) {
        expect(fs.existsSync(fiberNodePaths(node.id, settings).fiberStoreDir)).toBe(false);
        for (const field of ['config_file', 'rpc_token_file'] as const) {
          expect(fs.readFileSync(resolveNodeFile(node[field], settings), 'utf8')).toBe(`keep ${field}`);
        }
      }
      expect(fs.existsSync(settings.devnet.dataPath)).toBe(command === 'fiber');
    });
  });

  it.each(['config_file', 'rpc_token_file'] as const)(
    'refuses %s in CKB data before deleting chain or Fiber data',
    async (field) => {
      moveFile(field, path.join(settings.devnet.dataPath, field));
      await expect(reset('devnet')).rejects.toThrow(`Fiber node 1 ${field}`);
      expectAllDataKept();
    },
  );

  it('rechecks retained paths after confirmation before deleting any stores', async () => {
    jest.mocked(confirm).mockImplementationOnce(async () => {
      moveFile('config_file', path.join(fiberNodePaths(2, settings).fiberStoreDir, 'custom.yml'));
      return true;
    });
    await expect(fiberClean({ data: true }, settings)).rejects.toThrow('Fiber node 1 config_file');
    expectAllDataKept();
  });

  it('leaves externally referenced files after a full devnet cleanup', () => {
    const directory = path.join(root, 'external');
    moveFile('config_file', path.join(directory, 'custom.yml'));
    moveFile('rpc_token_file', path.join(directory, 'custom-token'));
    clean();
    expect(fs.existsSync(settings.devnet.configPath)).toBe(false);
    for (const field of ['config_file', 'rpc_token_file'] as const) {
      expect(fs.readFileSync(resolveNodeFile(manifest.nodes[0][field], settings), 'utf8')).toBe(`keep ${field}`);
    }
  });
});
