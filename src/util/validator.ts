import path from 'path';
import fs from 'fs';
import { Network, HexString, UdtKind } from '../type/base';
import { logger } from './logger';

export function validateTypescriptWorkspace() {
  const cwd = process.cwd();

  // Check if package.json exists
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('package.json not found in the current directory');
  }

  // Check if tsconfig.json exists
  const tsconfig = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    throw new Error('tsconfig.json not found in the current directory');
  }
}

export function validateExecDappEnvironment() {
  const cwd = process.cwd();

  // Check if package.json and tsconfig.json exists
  validateTypescriptWorkspace();

  // Check if offckb.config.ts exists
  const offCKBConfigPath = path.resolve(cwd, 'offckb.config.ts');
  if (!fs.existsSync(offCKBConfigPath)) {
    throw new Error('offckb.config.ts not found in the current directory');
  }

  // Read offckb.config.ts file
  const offCKBConfigFile = fs.readFileSync(offCKBConfigPath, 'utf-8');

  // Check if offckb.config.ts contains OffCKBConfig interface
  if (!offCKBConfigFile.includes('export interface OffCKBConfig')) {
    throw new Error('offckb.config.ts does not contain OffCKBConfig interface');
  }

  // Check if OffCKBConfig is exported
  if (!offCKBConfigFile.includes('export default offCKBConfig;')) {
    throw new Error('OffCKBConfig interface is not exported in offckb.config.ts');
  }
}

export function isValidNetworkString(network: string) {
  return ['devnet', 'testnet', 'mainnet'].includes(network);
}

export function validateNetworkOpt(network: string) {
  if (!isValidNetworkString(network)) {
    throw new Error('invalid network option, ' + network);
  }

  if (network === Network.mainnet) {
    logger.info(
      'Mainnet not support yet. Please use CKB-CLI to operate on mainnet for better security. Check https://github.com/nervosnetwork/ckb-cli',
    );
    process.exit(1);
  }
}

export function isValidVersion(version: unknown): boolean {
  if (typeof version !== 'string') {
    return false;
  }

  // Regular expression to match version strings like X.Y.Z or vX.Y.Z-rcN
  const versionRegex = /^v?\d+\.\d+\.\d+(-rc\d+)?$/;

  // Test the version against the regex
  return versionRegex.test(version);
}

export function normalizePrivKey(privKey: string): string {
  // Trim surrounding whitespaces
  let key = privKey ? privKey.trim() : '';

  if (!key) {
    throw new Error('Private key is required.');
  }

  // Strip surrounding quotes
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  if (key.startsWith("'") && key.endsWith("'")) {
    key = key.slice(1, -1);
  }

  // Trim again to normalize whitespace that was inside surrounding quotes
  key = key.trim();

  // Remove standard 0x/0X prefix if it exists manually for normalization
  if (/^0x/i.test(key)) {
    key = key.slice(2);
  }

  // Validate only hex characters are left
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('Invalid private key: contains non-hexadecimal characters.');
  }

  // Enforce exactly 32 bytes length
  if (key.length !== 64) {
    throw new Error(
      `Invalid private key length: expected 32 bytes (64 hex characters), but got ${key.length} characters (excluding 0x prefix).`,
    );
  }

  // Return the formally strictly padded ckb format `0x` string
  return '0x' + key;
}

export function isValidUdtKind(kind: string): kind is UdtKind {
  return kind === 'sudt' || kind === 'xudt';
}

export function validateUdtKind(kind?: string): asserts kind is UdtKind {
  if (!kind) {
    throw new Error('UDT kind is required');
  }
  if (!isValidUdtKind(kind)) {
    throw new Error(`invalid UDT kind "${kind}", must be "sudt" or "xudt"`);
  }
}

const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

export function validateUdtAmount(amount: string): bigint {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`invalid UDT amount "${amount}", must be a non-negative decimal integer`);
  }
  const value = BigInt(amount);
  if (value > U128_MAX) {
    throw new Error(`UDT amount exceeds 128-bit max: ${amount}`);
  }
  return value;
}

const HEX_REGEX = /^0x[0-9a-fA-F]*$/;

export function validateHexString(value: string, name: string): HexString {
  if (!value || !HEX_REGEX.test(value)) {
    throw new Error(`invalid ${name} "${value}", must be a hex string starting with 0x`);
  }
  return value as HexString;
}

export function validateUdtTypeArgs(kind: UdtKind, typeArgs: string): HexString {
  const hex = validateHexString(typeArgs, 'type args');
  const byteLength = (hex.length - 2) / 2;
  if (kind === 'sudt' && byteLength !== 20) {
    throw new Error(`invalid SUDT type args length: expected 20 bytes, got ${byteLength}`);
  }
  if (kind === 'xudt' && byteLength !== 32) {
    throw new Error(`invalid xUDT type args length: expected 32 bytes, got ${byteLength}`);
  }
  return hex;
}
