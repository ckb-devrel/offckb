import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePrivateKey } from '../src/util/private-key';

describe('resolvePrivateKey', () => {
  const originalEnv = process.env.OFFCKB_PRIVATE_KEY;
  afterEach(() => {
    if (originalEnv == null) delete process.env.OFFCKB_PRIVATE_KEY;
    else process.env.OFFCKB_PRIVATE_KEY = originalEnv;
  });

  it('reads a key from a file without putting it in argv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-key-'));
    const keyFile = path.join(root, 'key');
    fs.writeFileSync(keyFile, '0x1234\n');
    expect(resolvePrivateKey({ privkeyFile: keyFile })).toBe('0x1234');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('supports OFFCKB_PRIVATE_KEY and rejects ambiguous sources', () => {
    process.env.OFFCKB_PRIVATE_KEY = '0xabcd';
    expect(resolvePrivateKey({})).toBe('0xabcd');
    expect(() => resolvePrivateKey({ privkey: '0x1', privkeyFile: 'key' })).toThrow('only one');
  });

  it('fails with an actionable message when no source is available', () => {
    delete process.env.OFFCKB_PRIVATE_KEY;
    expect(() => resolvePrivateKey({})).toThrow('OFFCKB_PRIVATE_KEY');
  });

  it('uses a caller-provided dev key only when no explicit source is set', () => {
    delete process.env.OFFCKB_PRIVATE_KEY;
    expect(resolvePrivateKey({}, '0xdefault')).toBe('0xdefault');
    expect(resolvePrivateKey({ privkey: '0xexplicit' }, '0xdefault')).toBe('0xexplicit');
  });
});
