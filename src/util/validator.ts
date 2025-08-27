import path from 'path';
import fs from 'fs';
import { Network } from '../type/base';
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
