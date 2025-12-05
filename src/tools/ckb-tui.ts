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
    const platform = process.platform;
    const arch = process.arch;
    let assetName: string;

    if (platform === 'darwin') {
      if (arch === 'arm64') {
        assetName = `ckb-tui-with-node-macos-aarch64.tar.gz`;
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

      // Assume the binary is extracted as 'ckb-tui' or 'ckb-tui.exe'
      // todo: fix the bin name
      const extractedBinary = platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui-macos-amd64';
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

      // Make executable on Unix
      if (platform !== 'win32') {
        execSync(`chmod +x "${this.binaryPath}"`);
      }

      // Clean up archive
      fs.unlinkSync(archivePath);

      logger.info('ckb-tui installed successfully.');
    } catch (error) {
      logger.error('Failed to download/install ckb-tui:', (error as Error).message);
      throw error;
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
    const command = `"${binaryPath}" ${args.join(' ')}`;
    return spawnSync(command, { stdio: 'inherit', shell: true });
  }

  static runWithArgs(args: string[]) {
    this.run(args);
  }
}
