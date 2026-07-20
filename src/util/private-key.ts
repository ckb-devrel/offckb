import fs from 'fs';
import path from 'path';

export interface PrivateKeyInput {
  privkey?: string | null;
  privkeyFile?: string | null;
}

export function resolvePrivateKey(input: PrivateKeyInput, defaultKey?: string): string {
  if (input.privkey && input.privkeyFile) {
    throw new Error('Use only one of --privkey or --privkey-file.');
  }
  if (input.privkey) return input.privkey;
  if (input.privkeyFile) {
    const filePath = path.resolve(input.privkeyFile);
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      throw new Error(`Could not read private key file ${filePath}: ${(error as Error).message}`);
    }
  }
  if (process.env.OFFCKB_PRIVATE_KEY) return process.env.OFFCKB_PRIVATE_KEY;
  if (defaultKey) return defaultKey;
  throw new Error('--privkey, --privkey-file, or OFFCKB_PRIVATE_KEY is required!');
}
