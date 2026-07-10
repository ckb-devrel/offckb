import { spawnSync, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export class CKBTui {
  private static binaryPath: string | null = null;

  private static getBinaryPath(): string {
    if (!this.binaryPath) {
      const settings = readSettings();
      const binDir = settings.tools.rootFolder;
      const version = settings.tools.ckbTui.version;
      this.binaryPath = path.join(binDir, 'ckb-tui');

      if (!fs.existsSync(this.binaryPath)) {
        this.downloadBinary(version);
      }
    }
    return this.binaryPath;
  }

  private static downloadBinary(version: string) {
    // Validate version format to prevent URL manipulation
    if (!/^v\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`Invalid version format: ${version}. Expected format: vX.Y.Z`);
    }

    const platform = process.platform;
    const arch = process.arch;
    let assetName: string;

    if (platform === 'darwin') {
      if (arch !== 'arm64') {
        throw new Error(`Unsupported architecture for macOS: ${arch}. Only Apple Silicon (arm64) is supported.`);
      }
      assetName = `ckb-tui-with-node-macos-aarch64.tar.gz`;
    } else if (platform === 'linux') {
      if (arch !== 'x64') {
        throw new Error(`Unsupported architecture for Linux: ${arch}`);
      }
      assetName = `ckb-tui-with-node-linux-amd64.tar.gz`;
    } else if (platform === 'win32') {
      if (arch !== 'x64') {
        throw new Error(`Unsupported architecture for Windows: ${arch}`);
      }
      assetName = `ckb-tui-with-node-windows-amd64.zip`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const downloadUrl = `https://github.com/Officeyutong/ckb-tui/releases/download/${version}/${assetName}`;
    const binDir = path.dirname(this.binaryPath!);
    const archivePath = path.join(binDir, assetName);
    const binaryName = platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui';

    try {
      logger.info(`Downloading ckb-tui from ${downloadUrl}...`);
      execSync(`curl -L -o "${archivePath}" "${downloadUrl}"`, { stdio: 'inherit' });

      logger.info('Extracting...');
      if (assetName.endsWith('.tar.gz')) {
        execSync(`tar -xzf "${archivePath}" -C "${binDir}"`, { stdio: 'inherit' });
      } else if (assetName.endsWith('.zip')) {
        execSync(`unzip "${archivePath}" -d "${binDir}"`, { stdio: 'inherit' });
      }

      const extractedBinary = this.findBinary(binDir, binaryName);
      if (!extractedBinary) {
        logger.error(`ckb-tui binary was not found after extraction. Expected: ${binaryName}`);
        throw new Error('Failed to extract and locate ckb-tui binary.');
      }

      fs.renameSync(extractedBinary, this.binaryPath!);

      // Make executable on Unix
      if (platform !== 'win32') {
        execSync(`chmod +x "${this.binaryPath}"`);
      }

      logger.info('ckb-tui installed successfully.');
    } catch (error) {
      logger.error(
        'Failed to download/install ckb-tui:',
        (error as Error).message,
        '\nPlease check your network connectivity, verify that the specified version exists in the releases, and ensure you have sufficient file system permissions.',
      );
      throw error;
    } finally {
      // Clean up archive even if error occurs
      if (fs.existsSync(archivePath)) {
        try {
          fs.unlinkSync(archivePath);
        } catch (cleanupError) {
          logger.warn('Failed to clean up archive file:', (cleanupError as Error).message);
        }
      }
    }
  }

  private static findBinary(dir: string, binaryName: string): string | null {
    // Check direct path first
    const directPath = path.join(dir, binaryName);
    if (fs.existsSync(directPath)) {
      return directPath;
    }

    // Search in subdirectories
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
        const candidate = path.join(entryPath, binaryName);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  static isInstalled(): boolean {
    try {
      const binPath = this.getBinaryPath();
      return fs.existsSync(binPath);
    } catch {
      return false;
    }
  }

  static run(args: string[] = []) {
    const binaryPath = this.getBinaryPath();
    return spawnSync(binaryPath, args, { stdio: 'inherit' });
  }
}
