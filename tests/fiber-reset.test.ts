import fs from 'fs';
import os from 'os';
import path from 'path';
import * as settingsModule from '../src/cfg/setting';
import { fiberNodePaths } from '../src/fiber/paths';
import { fiberClean } from '../src/fiber/clean';
import { clean } from '../src/cmd/clean';

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
