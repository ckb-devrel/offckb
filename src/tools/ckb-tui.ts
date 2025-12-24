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
      if (arch === 'arm64') {
        assetName = `ckb-tui-with-node-macos-aarch64.tar.gz`;
      } else if (arch === 'x64') {
        assetName = `ckb-tui-with-node-macos-amd64.tar.gz`;
      } else {
        throw new Error(`Unsupported architecture for macOS: ${arch}`);
      }
    } else if (platform === 'linux') {
      if (arch === 'x64') {
        assetName = `ckb-tui-with-node-linux-amd64.tar.gz`;
      } else {
        throw new Error(`Unsupported architecture for Linux: ${arch}`);
      }
    } else if (platform === 'win32') {
      if (arch === 'x64') {
        assetName = `ckb-tui-with-node-windows-amd64.zip`;
      } else {
        throw new Error(`Unsupported architecture for Windows: ${arch}`);
      }
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const downloadUrl = `https://github.com/Officeyutong/ckb-tui/releases/download/${version}/${assetName}`;
    const binDir = path.dirname(this.binaryPath!);
    const archivePath = path.join(binDir, assetName);

    try {
      logger.info(`Downloading ckb-tui from ${downloadUrl}...`);
      execSync(`curl -L -o "${archivePath}" "${downloadUrl}"`, { stdio: 'inherit' });

      logger.info('Extracting...');
      if (assetName.endsWith('.tar.gz')) {
        execSync(`tar -xzf "${archivePath}" -C "${binDir}"`, { stdio: 'inherit' });
      } else if (assetName.endsWith('.zip')) {
        execSync(`unzip "${archivePath}" -d "${binDir}"`, { stdio: 'inherit' });
      }

      // Set the correct binary name based on platform and architecture
      let extractedBinary: string;
      if (platform === 'win32') {
        extractedBinary = 'ckb-tui.exe';
      } else if (platform === 'darwin') {
        if (arch === 'arm64') {
          extractedBinary = 'ckb-tui-macos-aarch64';
        } else {
          extractedBinary = 'ckb-tui-macos-amd64';
        }
      } else if (platform === 'linux') {
        if (arch === 'x64') {
          extractedBinary = 'ckb-tui-linux-amd64';
        } else {
          throw new Error(`Unsupported architecture for Linux: ${arch}`);
        }
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
      const extractedPath = path.join(binDir, extractedBinary);
      if (fs.existsSync(extractedPath)) {
        fs.renameSync(extractedPath, this.binaryPath!);
      } else {
        // If in a subfolder, find it
        const files = fs.readdirSync(binDir);
        for (const file of files) {
          const filePath = path.join(binDir, file);
          if (fs.statSync(filePath).isDirectory()) {
            const candidate = path.join(filePath, extractedBinary);
            if (fs.existsSync(candidate)) {
              fs.renameSync(candidate, this.binaryPath!);
              break;
            }
          }
        }
      }

      // Check that the binary was successfully extracted and moved
      if (!fs.existsSync(this.binaryPath!)) {
        logger.error(`ckb-tui binary was not found after extraction. Expected at: ${this.binaryPath}`);
        throw new Error('Failed to extract and locate ckb-tui binary.');
      }

      // Make executable on Unix
      if (platform !== 'win32') {
        execSync(`chmod +x "${this.binaryPath}"`);
      }

      logger.info('ckb-tui installed successfully.');
    } catch (error) {
      logger.error(
        'Failed to download/install ckb-tui:',
        (error as Error).message,
        '\nPlease check your network connectivity, verify that the specified version exists in the releases, and ensure you have sufficient file system permissions.'
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

  static isInstalled(): boolean {
    try {
      const path = this.getBinaryPath();
      return fs.existsSync(path);
    } catch {
      return false;
    }
  }

  static run(args: string[] = []) {
    const binaryPath = this.getBinaryPath();
    return spawnSync(binaryPath, args, { stdio: 'inherit' });
  }
}
