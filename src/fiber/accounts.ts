import * as fs from 'fs';
import crypto from 'crypto';
import { ccc } from '@ckb-ccc/core';
import accountConfig from '../../account/account.json';
import { fiberAccountIndex, fiberNodePaths, UDT_ISSUER_ACCOUNT_INDEX } from './paths';
import { readSettings, Settings } from '../cfg/setting';
import type { FundingAccount, FiberNodeEntry } from './nodes-yml';
import { readRegularFile, writePrivateFile } from './files';
import { logger } from '../util/logger';

export interface BuiltinAccount {
  privkey: string;
  pubkey: string;
  lockScript: {
    codeHash: string;
    hashType: string;
    args: string;
  };
  address: string;
  args: string;
}

const accounts = accountConfig as unknown as BuiltinAccount[];

export function getBuiltinAccount(index: number): BuiltinAccount {
  const account = accounts[index];
  if (!Number.isInteger(index) || index < 0 || !account) {
    throw new Error(`Built-in account #${index} does not exist (account.json has ${accounts.length} accounts).`);
  }
  return account;
}

// Node N uses CKB account N+2; accounts 3-18 are reserved for Fiber nodes.
export function fiberNodeAccount(nodeId: number): BuiltinAccount {
  return getBuiltinAccount(fiberAccountIndex(nodeId));
}

// Account 19 deploys contracts and issues the sUDT/xUDT used for testing.
export function udtIssuerAccount(): BuiltinAccount {
  return getBuiltinAccount(UDT_ISSUER_ACCOUNT_INDEX);
}

export function udtIssuerLockHash(): string {
  const issuer = udtIssuerAccount();
  return ccc.Script.from(issuer.lockScript as ccc.ScriptLike).hash();
}

// Derive the compressed secp256k1 public key of a raw 32-byte secret, the
// format FNN reports as node_info.pubkey (hex, no 0x prefix).
export function fiberPublicKeyFromSecret(secret: Buffer): string {
  const signer = new ccc.SignerCkbPrivateKey({} as never, `0x${secret.toString('hex')}` as `0x${string}`);
  return signer.publicKey.slice(2).toLowerCase();
}

export function readFiberNodeSecretKey(nodeId: number, settings: Settings = readSettings()): Buffer | null {
  const skFile = fiberNodePaths(nodeId, settings).fiberSkFile;
  try {
    const data = fs.readFileSync(skFile);
    return data.length >= 32 ? data.subarray(0, 32) : null;
  } catch {
    return null;
  }
}

export function validatePrivateKey(key: unknown, field = 'account.key'): asserts key is string {
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error(`Invalid ${field}: expected a 0x-prefixed 32-byte private key.`);
  try {
    fiberPublicKeyFromSecret(Buffer.from(key.slice(2), 'hex'));
  } catch {
    throw new Error(`Invalid ${field}: not a valid secp256k1 private key.`);
  }
}

export function resolveFundingAccount(account: FundingAccount): BuiltinAccount {
  if (account.type === 'builtin') return getBuiltinAccount(account.index);
  validatePrivateKey(account.key);
  const signer = new ccc.SignerCkbPrivateKey({} as never, account.key as `0x${string}`);
  const args = ccc.hashCkb(signer.publicKey).slice(0, 42);
  const lockScript = { ...getBuiltinAccount(0).lockScript, args };
  const client = new ccc.ClientPublicTestnet();
  return {
    privkey: account.key,
    pubkey: signer.publicKey,
    args,
    lockScript,
    address: ccc.Address.fromScript(ccc.Script.from(lockScript), client).toString(),
  };
}

export function warnSharedAccounts(nodes: FiberNodeEntry[]) {
  const groups = new Map<string, { ids: number[]; address: string }>();
  for (const node of nodes) {
    const account = resolveFundingAccount(node.account);
    const lock = ccc.Script.from(account.lockScript).hash();
    const group = groups.get(lock) ?? { ids: [], address: account.address };
    group.ids.push(node.id);
    groups.set(lock, group);
  }
  for (const group of groups.values())
    if (group.ids.length > 1) {
      logger.warn(
        `Fiber nodes ${group.ids.join(', ')} share funding account ${group.address}. Concurrent transactions may compete for Cells; FNN may reject shared funding inputs.`,
      );
    }
}

// FNN v0.9.0 utils/encrypt_decrypt_file.rs: version | salt(16) | nonce(12) |
// AES-256-GCM ciphertext and tag(16), scrypt 0.11 recommended parameters.
export function assertNodeFundingKey(node: FiberNodeEntry, settings: Settings = readSettings()) {
  const file = fiberNodePaths(node.id, settings).ckbKeyFile;
  const data = readRegularFile(file);
  let actual: string;
  try {
    if (/^(0x)?[0-9a-f]{64}$/i.test(data.toString('utf8').trim()))
      actual = data.toString('utf8').trim().replace(/^0x/, '');
    else {
      if (data[0] !== 0 || data.length < 46) throw new Error('unsupported encrypted key');
      const key = crypto.scryptSync(readNodePassword(node.id, settings), data.subarray(1, 17), 32, {
        N: 131072,
        r: 8,
        p: 1,
        maxmem: 256 * 1024 * 1024,
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(17, 29));
      decipher.setAuthTag(data.subarray(-16));
      const plain = Buffer.concat([decipher.update(data.subarray(29, -16)), decipher.final()]);
      actual = plain.length === 32 ? plain.toString('hex') : plain.toString('utf8').trim().replace(/^0x/, '');
    }
  } catch {
    throw new Error(`Fiber node ${node.id}: cannot decrypt or read ${file}; check its key format and password.`);
  }
  if (actual.toLowerCase() !== resolveFundingAccount(node.account).privkey.slice(2).toLowerCase()) {
    throw new Error(
      `Fiber node ${node.id}: account record does not match ${file}. Restore the original binding; use a new node to test another account.`,
    );
  }
}

/**
 * Create the node directory layout and its CKB key material. The CKB secret
 * key is written as plain hex (FNN encrypts it in place on first start,
 * using the per-node password passed via FIBER_SECRET_KEY_PASSWORD). The
 * Fiber network identity key (fiber/sk) is generated by FNN itself on first
 * start and must never be overwritten here.
 *
 * Existing nodes keep their key and password; a node directory with missing
 * key material is an error, never silently re-created (the on-chain account
 * and any channels are tied to the original keys).
 */
export function ensureNodeKeyMaterial(
  nodeId: number,
  settings: Settings = readSettings(),
  accountBinding?: FundingAccount,
  preparing = false,
): { created: boolean } {
  const paths = fiberNodePaths(nodeId, settings);
  const keyExists = fs.existsSync(paths.ckbKeyFile);
  const passwordExists = fs.existsSync(paths.passwordFile);
  if (keyExists && passwordExists) {
    return { created: false };
  }
  if (keyExists !== passwordExists && !preparing) {
    const missing = keyExists ? paths.passwordFile : paths.ckbKeyFile;
    throw new Error(
      `Fiber node ${nodeId} has incomplete key material: ${missing} is missing. ` +
        'The CKB key and its password must both come from the same provisioning; ' +
        'restore the file or remove the node directory and start again.',
    );
  }

  fs.mkdirSync(paths.ckbDir, { recursive: true });
  fs.mkdirSync(paths.fiberDir, { recursive: true });
  const account = accountBinding ? resolveFundingAccount(accountBinding) : fiberNodeAccount(nodeId);
  if (!keyExists) writePrivateFile(paths.ckbKeyFile, account.privkey.replace(/^0x/, ''));
  if (!passwordExists) writePrivateFile(paths.passwordFile, crypto.randomBytes(24).toString('base64'));
  return { created: true };
}

export function readNodePassword(nodeId: number, settings: Settings = readSettings()): string {
  const passwordFile = fiberNodePaths(nodeId, settings).passwordFile;
  try {
    const password = readRegularFile(passwordFile).toString('utf8').trim();
    if (!password) throw new Error('password is empty');
    return password;
  } catch (error) {
    throw new Error(`Failed to read the password of fiber node ${nodeId}: ${(error as Error).message}`);
  }
}
