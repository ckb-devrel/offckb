import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { fiberNodePaths } from '../src/fiber/paths';
import {
  ensureNodeKeyMaterial,
  fiberNodeAccount,
  fiberPublicKeyFromSecret,
  readFiberNodeSecretKey,
  readNodePassword,
  udtIssuerAccount,
  udtIssuerLockHash,
} from '../src/fiber/accounts';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function fixture(): Settings {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-keys-'));
  tempRoots.push(root);
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.configPath = path.join(root, 'devnet');
  return settings;
}

describe('fiber accounts', () => {
  it('maps node N to built-in account N+2', () => {
    expect(fiberNodeAccount(1).args).toBe('0xe65f823bc5a48a38515690604e503dba4eb15d61'); // account #3
    expect(fiberNodeAccount(2).args).toBe('0x9665e6bc1966ec2bfcca4f11782d2b906f38438f'); // account #4
  });

  it('uses account 19 as the UDT issuer with a stable lock hash', () => {
    expect(udtIssuerAccount().args).toBe('0x4118c8c16749bf126b22468d030bf9de7da3717b');
    expect(udtIssuerLockHash()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(udtIssuerLockHash()).toBe('0x4472b33b4e1845ebe82f2ce5f511bbe012f144c5f3d7b539909adffc83ccda61');
  });
});

describe('ensureNodeKeyMaterial', () => {
  it('writes the CKB key (hex, no 0x) and a random password, both owner-only', () => {
    const settings = fixture();
    const { created } = ensureNodeKeyMaterial(1, settings);
    expect(created).toBe(true);

    const paths = fiberNodePaths(1, settings);
    const key = fs.readFileSync(paths.ckbKeyFile, 'utf8');
    expect(key).toBe(fiberNodeAccount(1).privkey.replace(/^0x/, ''));
    expect(key.startsWith('0x')).toBe(false);

    const password = readNodePassword(1, settings);
    expect(password.length).toBeGreaterThan(16);

    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.ckbKeyFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.passwordFile).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps existing key material on later starts', () => {
    const settings = fixture();
    ensureNodeKeyMaterial(1, settings);
    const paths = fiberNodePaths(1, settings);
    const password = fs.readFileSync(paths.passwordFile, 'utf8');

    const { created } = ensureNodeKeyMaterial(1, settings);
    expect(created).toBe(false);
    expect(fs.readFileSync(paths.passwordFile, 'utf8')).toBe(password);
  });

  it('refuses to provision a node with half-missing key material', () => {
    const settings = fixture();
    ensureNodeKeyMaterial(1, settings);
    fs.unlinkSync(fiberNodePaths(1, settings).passwordFile);
    expect(() => ensureNodeKeyMaterial(1, settings)).toThrow('incomplete key material');
  });
});

describe('fiber identity key', () => {
  it('derives the compressed pubkey from a raw 32-byte secret', () => {
    // account #3's known privkey/pubkey pair doubles as a test vector.
    const secret = Buffer.from(fiberNodeAccount(1).privkey.replace(/^0x/, ''), 'hex');
    expect(fiberPublicKeyFromSecret(secret)).toBe(fiberNodeAccount(1).pubkey.replace(/^0x/, '').toLowerCase());
  });

  it('reads fiber/sk as raw bytes and tolerates a missing file', () => {
    const settings = fixture();
    expect(readFiberNodeSecretKey(1, settings)).toBeNull();

    const paths = fiberNodePaths(1, settings);
    fs.mkdirSync(paths.fiberDir, { recursive: true });
    fs.writeFileSync(paths.fiberSkFile, Buffer.alloc(32, 7));
    expect(readFiberNodeSecretKey(1, settings)).toEqual(Buffer.alloc(32, 7));
  });
});
