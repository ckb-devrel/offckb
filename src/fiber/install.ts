import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import os from 'os';
import yaml from 'js-yaml';
import { Request } from '../util/request';
import { getVersionFromBinary } from '../node/install';
import { unZipFile } from '../node/install';
import { readSettings, Settings } from '../cfg/setting';
import { bundledFiberTestnetConfigPath } from './paths';
import { logger } from '../util/logger';

// Only FNN versions tested against the contracts and config rules bundled
// with this offckb release may be downloaded. Other versions require
// --binary-path / --fnn-binary-path with a locally built FNN.
export const SUPPORTED_FNN_VERSIONS = ['0.9.0-rc7'] as const;
export const DEFAULT_FNN_VERSION = SUPPORTED_FNN_VERSIONS[0];

// Independently pinned SHA-256 digests of the upstream release tarballs,
// keyed by version then package name (same pattern as ckb-tui's
// KNOWN_SHA256). The FNN release publishes no checksums asset, so the
// download is verified against these pins before anything is extracted;
// a version or package without a pin fails closed.
export const KNOWN_FNN_SHA256: Record<string, Record<string, string>> = {
  '0.9.0-rc7': {
    'fnn_v0.9.0-rc7-x86_64-linux-portable': 'a27627e8cea2304e6075084d2fab72cd1276f512548351d6060e26622cc26faa',
    'fnn_v0.9.0-rc7-aarch64-linux-portable': 'fc25e907f9f24d345397da5794bac09c03fd76456a0f776bf3377192e3689143',
    'fnn_v0.9.0-rc7-x86_64-darwin-portable': '3ffa7ca2e3801e2d549c306200ae3add9ee90ec4a5093dfad6fefe04881e107b',
    'fnn_v0.9.0-rc7-aarch64-darwin-portable': '0127370913d7ec0291c0e1e38a0fff06efb6cdf999bafc87abb5b98e23b5df47',
    'fnn_v0.9.0-rc7-x86_64-windows': '7c9dd492a481aa18079aef17134bc16e8e247bd0535cb0372ab3476d55cb688b',
  },
};

export interface ResolvedFnn {
  fnnPath: string;
  testnetConfigPath: string;
  // Where the binary came from: a downloaded release or a user-supplied path.
  source: 'download' | 'binary-path';
  // Version reported by the binary, when it can be probed.
  version: string | null;
}

export function getFnnInstallPath(version: string, settings: Settings = readSettings()): string {
  return path.join(settings.bins.rootFolder, 'fnn', version);
}

export function getFnnBinaryPath(version: string, settings: Settings = readSettings()): string {
  const binaryName = process.platform === 'win32' ? 'fnn.exe' : 'fnn';
  return path.join(getFnnInstallPath(version, settings), binaryName);
}

export function getFnnBundledTestnetConfigPath(version: string, settings: Settings = readSettings()): string {
  return path.join(getFnnInstallPath(version, settings), 'config', 'testnet', 'config.yml');
}

function buildFnnPackageName(version: string): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'linux') {
    return arch === 'arm64' ? `fnn_v${version}-aarch64-linux-portable` : `fnn_v${version}-x86_64-linux-portable`;
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? `fnn_v${version}-aarch64-darwin-portable` : `fnn_v${version}-x86_64-darwin-portable`;
  }
  if (platform === 'win32') {
    // Fiber only publishes x86_64 Windows packages.
    return `fnn_v${version}-x86_64-windows`;
  }
  throw new Error(`Unsupported operating system for FNN: ${platform}`);
}

export function buildFnnDownloadUrl(version: string): string {
  const packageName = buildFnnPackageName(version);
  return `https://github.com/nervosnetwork/fiber/releases/download/v${version}/${packageName}.tar.gz`;
}

export function assertSupportedFnnVersion(version: string) {
  if (!(SUPPORTED_FNN_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `FNN version ${version} is not supported by this offckb release. ` +
        `Supported versions: ${SUPPORTED_FNN_VERSIONS.join(', ')}. ` +
        'To run a different FNN, use --binary-path with a locally built binary.',
    );
  }
}

// The release tarball must keep its full extracted layout: the bundled
// config/testnet/config.yml is the starting point for the devnet config.
function isInstallComplete(version: string, settings: Settings): boolean {
  const configPath = getFnnBundledTestnetConfigPath(version, settings);
  if (!fs.existsSync(getFnnBinaryPath(version, settings)) || !fs.existsSync(configPath)) return false;
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
    return parsed != null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/**
 * Verify a downloaded release tarball against its pinned SHA-256. Fails
 * closed: an unsupported version or package has no pin and is rejected, as
 * is any digest mismatch — nothing unverified is ever extracted.
 */
export function verifyFnnPackageChecksum(version: string, packageName: string, filePath: string): void {
  const pinned = KNOWN_FNN_SHA256[version]?.[packageName];
  if (!pinned) {
    throw new Error(
      `No trusted SHA-256 checksum is pinned for FNN ${version} (${packageName}). ` +
        'Refusing to install an unverified binary.',
    );
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== pinned) {
    throw new Error(
      `SHA-256 checksum mismatch for ${packageName}.tar.gz.\n` +
        `Expected: ${pinned}\nActual:   ${actual}\n` +
        'The downloaded file may be corrupted or tampered with; refusing to install it.',
    );
  }
  logger.info('FNN release checksum verified (SHA-256).');
}

export async function downloadFnnAndUnzip(version: string, settings: Settings = readSettings()) {
  const packageName = buildFnnPackageName(version);
  const downloadURL = buildFnnDownloadUrl(version);
  const tempFilePath = path.join(os.tmpdir(), `${packageName}.tar.gz`);

  logger.info(`downloading ${downloadURL} ..`);
  const response = await Request.send(downloadURL);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

  try {
    verifyFnnPackageChecksum(version, packageName, tempFilePath);
    const extractDir = path.join(settings.bins.downloadPath, `fnn_v${version}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    await unZipFile(tempFilePath, extractDir, true);

    // FNN packages ship the binary and config/ flat at the tarball root (unlike
    // CKB packages, which nest everything in a package-name directory); accept
    // either layout.
    const nestedPath = path.join(extractDir, packageName);
    const sourcePath = fs.existsSync(nestedPath) ? nestedPath : extractDir;
    if (!fs.existsSync(path.join(sourcePath, process.platform === 'win32' ? 'fnn.exe' : 'fnn'))) {
      throw new Error(`FNN release package layout is unexpected: no fnn binary found in ${extractDir}.`);
    }
    const targetPath = getFnnInstallPath(version, settings);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      fs.cpSync(path.join(sourcePath, entry), path.join(targetPath, entry), { recursive: true, force: true });
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (process.platform !== 'win32') {
      fs.chmodSync(getFnnBinaryPath(version, settings), '755');
    }
  } finally {
    // The tarball is only an intermediate; never leave it in the temp dir,
    // whether the install succeeded or failed.
    fs.rmSync(tempFilePath, { force: true });
  }
  logger.info(`FNN ${version} installed successfully.`);
}

/**
 * Ensure a supported FNN release is installed. A cached install whose binary
 * is missing, won't run, reports a different version, or lost its bundled
 * testnet config is replaced by one fresh download; no retry loop.
 */
export async function installFnnBinary(version: string, settings: Settings = readSettings()) {
  assertSupportedFnnVersion(version);

  const binPath = getFnnBinaryPath(version, settings);
  const cachedVersion = getVersionFromBinary(binPath);
  if (cachedVersion === version && isInstallComplete(version, settings)) {
    return;
  }
  if (cachedVersion && cachedVersion !== version) {
    logger.info(`Cached FNN version ${cachedVersion} does not match ${version}; downloading the release build.`);
  } else if (!cachedVersion) {
    logger.info(`FNN binary not found or unusable, downloading FNN ${version} ..`);
  } else {
    logger.info(`FNN ${version} installation is incomplete (missing bundled config); downloading again ..`);
  }
  await downloadFnnAndUnzip(version, settings);

  const installedVersion = getVersionFromBinary(binPath);
  if (installedVersion !== version || !isInstallComplete(version, settings)) {
    throw new Error(
      `FNN ${version} was downloaded but the installed binary reports ` +
        `${installedVersion ?? 'no usable version'}; installation failed.`,
    );
  }
}

/**
 * Resolve the FNN binary and the testnet config used as the devnet config
 * template. A user-supplied binary path skips download and version checks;
 * its sibling config/testnet/config.yml is used when present (and must
 * parse), otherwise the testnet config shipped with offckb is the fallback.
 */
export async function resolveFnnBinary(
  options: { version?: string; binaryPath?: string },
  settings: Settings = readSettings(),
): Promise<ResolvedFnn> {
  if (options.binaryPath) {
    const fnnPath = options.binaryPath;
    if (!fs.existsSync(fnnPath)) {
      throw new Error(`FNN binary not found at ${fnnPath}`);
    }
    const siblingConfig = path.join(path.dirname(fnnPath), 'config', 'testnet', 'config.yml');
    let testnetConfigPath: string;
    if (fs.existsSync(siblingConfig)) {
      try {
        const parsed = yaml.load(fs.readFileSync(siblingConfig, 'utf8'));
        if (parsed == null || typeof parsed !== 'object') throw new Error('empty or non-object config');
        testnetConfigPath = siblingConfig;
      } catch (error) {
        throw new Error(
          `The testnet config next to the FNN binary (${siblingConfig}) cannot be parsed: ${(error as Error).message}. ` +
            'Fix that file or remove it to fall back to the config shipped with offckb.',
        );
      }
    } else {
      testnetConfigPath = bundledFiberTestnetConfigPath();
      if (!fs.existsSync(testnetConfigPath)) {
        throw new Error(`Bundled FNN testnet config is missing at ${testnetConfigPath}.`);
      }
      logger.info(`No config/testnet/config.yml next to ${fnnPath}; using the testnet config shipped with offckb.`);
    }
    logger.info(`Using FNN testnet config: ${testnetConfigPath}`);
    return { fnnPath, testnetConfigPath, source: 'binary-path', version: getVersionFromBinary(fnnPath) };
  }

  const version = options.version || settings.bins.defaultFnnVersion || DEFAULT_FNN_VERSION;
  await installFnnBinary(version, settings);
  return {
    fnnPath: getFnnBinaryPath(version, settings),
    testnetConfigPath: getFnnBundledTestnetConfigPath(version, settings),
    source: 'download',
    version,
  };
}
