import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';
import { getFixedArraySpec } from '../src/tui/devnet-config-metadata';

describe('devnet-config-metadata rpc.modules spec', () => {
  it('offers the Terminal and RichIndexer modules in the config editor', () => {
    const spec = getFixedArraySpec(['rpc', 'modules']);
    expect(spec).not.toBeNull();
    expect(spec!.options).toContain('Terminal');
    expect(spec!.options).toContain('RichIndexer');
  });

  it('covers every module enabled by the bundled devnet ckb.toml', () => {
    const templatePath = path.resolve(__dirname, '..', 'ckb', 'devnet', 'ckb.toml');
    const parsed = toml.parse(fs.readFileSync(templatePath, 'utf8'));
    const templateModules = (parsed.rpc as JsonMap).modules as string[];

    const spec = getFixedArraySpec(['rpc', 'modules']);
    for (const moduleName of templateModules) {
      expect(spec!.options).toContain(moduleName);
    }
  });
});
