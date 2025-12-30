import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';
import os from 'os';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { Request } from '../util/request';
import { getCKBBinaryInstallPath, getCKBBinaryPath, readSettings } from '../cfg/setting';
import { encodeBinPathForTerminal } from '../util/encoding';
import { logger } from '../util/logger';

export async function installCKBBinary(version: string) {
  const ckbBinPath = getCKBBinaryPath(version);
  const outputVersion = getVersionFromBinary(ckbBinPath);
  if (outputVersion) {
    if (!semver.eq(version, outputVersion)) {
      logger.info(
        `CKB version ${outputVersion} is not equal to the ${version}, download and install the new version ${version}..`,
      );
    } else {
      return;
    }
  } else {
    logger.info(`CKB Binary not found, download and install the new version ${version}..`);
  }

  await downloadCKBBinaryAndUnzip(version);
}

export async function downloadCKBBinaryAndUnzip(version: string) {
  const ckbPackageName = buildCKBGithubReleasePackageName(version);
  try {
    const ext = getExtension();
    const tempFilePath = path.join(os.tmpdir(), `${ckbPackageName}.${ext}`);
    await downloadAndSaveCKBBinary(version, tempFilePath);

    // Unzip the file
    const extractDir = path.join(readSettings().bins.downloadPath, `ckb_v${version}`);
    await unZipFile(tempFilePath, extractDir, ext === 'tar.gz');

    // Install the extracted files
    const sourcePath = path.join(extractDir, ckbPackageName);
    const targetPath = getCKBBinaryInstallPath(version);
    if (fs.existsSync(targetPath)) {
      fs.rmdirSync(targetPath, { recursive: true });
    }
    fs.mkdirSync(targetPath, { recursive: true });
    fs.renameSync(sourcePath, targetPath); // Move binary to desired location
    fs.chmodSync(getCKBBinaryPath(version), '755'); // Make the binary executable

    logger.info(`CKB ${version} installed successfully.`);
  } catch (error) {
    logger.error('Error installing dependency binary:', error);
  }
}

export async function downloadAndSaveCKBBinary(version: string, tempFilePath: string) {
  const downloadURL = buildDownloadUrl(version);
  logger.info(`downloading ${downloadURL} ..`);
  const response = await Request.send(downloadURL);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));
}

export async function unZipFile(filePath: string, extractDir: string, useTar: boolean = false) {
  // Ensure the destination directory exists, if not create it
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }

  if (useTar === true) {
    return await decompressTarGzAsync(filePath, extractDir);
  }

  const zip = new AdmZip(filePath);
  zip.extractAllTo(extractDir, true);
}

export async function decompressTarGzAsync(tarballPath: string, destinationDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Create a readable stream from the .tar.gz file
    const tarballStream = fs.createReadStream(tarballPath);

    // Extract the contents of the .tar.gz file to the destination directory
    tarballStream
      .pipe(
        tar.x({
          cwd: destinationDir,
        }),
      )
      .on('error', (err) => {
        logger.error('Error extracting tarball:', err);
        reject(err); // Reject with error if extraction fails
      })
      .on('finish', () => {
        logger.info('Extraction complete.');
        resolve(); // Resolve when extraction completes
      });
  });
}

export function getVersionFromBinary(binPath: string): string | null {
  try {
    const versionOutput = execSync(`${encodeBinPathForTerminal(binPath)} --version`, {
      encoding: 'utf-8',
    });

    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+(-rc\d+)?)/);
    if (versionMatch) {
      return versionMatch[0];
    }
    return null;
  } catch (error) {
    return null;
  }
}

function getOS(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return 'apple-darwin';
  } else if (platform === 'linux') {
    return 'unknown-linux-gnu';
  } else if (platform === 'win32') {
    return 'pc-windows-msvc';
  } else {
    throw new Error('Unsupported operating system');
  }
}

function getArch(): string {
  const arch = os.arch();
  if (arch === 'x64') {
    return 'x86_64';
  } else if (arch === 'arm64') {
    return 'aarch64';
  } else {
    throw new Error('Unsupported architecture');
  }
}

function getExtension(): 'tar.gz' | 'zip' {
  const platform = os.platform();
  if (platform === 'linux') {
    return 'tar.gz';
  }
  return 'zip';
}

function isPortable(): boolean {
  try {
    const CPUFeatures = require('cpu-features');
    const features = CPUFeatures();
    if (features.arch === 'x86') {
      const flags = features.flags as any; // CPUFeatures.X86CpuFlags
      // if lacks any of the following instruction, use portable binary
      return !(flags.avx2 && flags.sse4_2 && flags.bmi2 && flags.pclmulqdq);
    }
  } catch (error) {
    // If cpu-features fails to load (e.g., on Windows without build tools), assume portable
    logger.warn('Failed to detect CPU features, using portable binary');
  }
  return false;
}

function buildCKBGithubReleasePackageName(version: string, opt: { os?: string; arch?: string } = {}) {
  const os = opt.os || getOS();
  const arch = opt.arch || getArch();

  if (isPortable()) {
    return `ckb_v${version}_${arch}-${os}-portable`;
  } else {
    return `ckb_v${version}_${arch}-${os}`;
  }
}

function buildCKBGithubReleasePackageNameWithExtension(
  version: string,
  opt: { os?: string; arch?: string; ext?: string } = {},
): string {
  const os = opt.os || getOS();
  const arch = opt.arch || getArch();
  const extension = opt.ext || getExtension();

  if (isPortable()) {
    return `ckb_v${version}_${arch}-${os}-portable.${extension}`;
  } else {
    return `ckb_v${version}_${arch}-${os}.${extension}`;
  }
}

export function buildDownloadUrl(version: string, opt: { os?: string; arch?: string; ext?: string } = {}): string {
  const fullPackageName = buildCKBGithubReleasePackageNameWithExtension(version, opt);
  return `https://github.com/nervosnetwork/ckb/releases/download/v${version}/${fullPackageName}`;
}
