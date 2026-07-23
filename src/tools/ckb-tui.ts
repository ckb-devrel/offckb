import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { readSettings, dataPath } from '../cfg/setting';
import { logger } from '../util/logger';
import { findFileInFolder } from '../util/fs';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;

// Strict semver regex: v<major>.<minor>.<patch> (no leading zeros on digits)
const STRICT_VERSION_REGEX = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Independently pinned digests for the default release. Keeping these in
// offckb makes the default installation verifiable even though ckb-tui v0.1.3
// did not upload a checksums-sha256.txt asset.
const KNOWN_SHA256: Record<string, Record<string, string>> = {
  'v0.1.3': {
    'ckb-tui-with-node-linux-amd64.tar.gz': '33455cefe2c016149fa8fa3abde7960b348d4606afef9279d787ac8a8b59956f',
    'ckb-tui-with-node-macos-aarch64.tar.gz': 'de18107ec179ced03608da956013e38ae82e6c1fae588f12c17d138ee6ee072c',
    'ckb-tui-with-node-windows-amd64.zip': '749d8e09fd5d23fc8af12892b7d197add5aae004f7438678023e4a973f3fd58b',
  },
};

export class CKBTui {
  private static binaryPath: string | null = null;

  /**
   * Pure lookup — returns the expected binary path without triggering any
   * download or installation side effects. May return null if not yet computed.
   */
  static getBinaryPath(): string | null {
    if (!this.binaryPath) {
      const settings = readSettings();
      const binDir = this.resolveAndValidateBinDir(settings.tools.rootFolder);
      const binaryName = process.platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui';
      this.binaryPath = path.join(binDir, binaryName);
    }
    return this.binaryPath;
  }

  /**
   * Returns the binary path, downloading and installing if the binary
   * does not already exist.
   */
  static ensureInstalled(): string {
    const binaryPath = this.getBinaryPath();
    if (binaryPath && fs.existsSync(binaryPath)) {
      return binaryPath;
    }

    // Reset and re-install
    this.binaryPath = null;
    this.installSync();
    return this.binaryPath!;
  }

  static isInstalled(): boolean {
    try {
      const binPath = this.getBinaryPath();
      return binPath !== null && fs.existsSync(binPath);
    } catch {
      return false;
    }
  }

  static run(args: string[] = []) {
    const binaryPath = this.ensureInstalled();
    return spawnSync(binaryPath, args, { stdio: 'inherit' });
  }

  // --- private helpers ---

  /**
   * Resolve and validate that the configured rootFolder is under the
   * OffCKB data directory. Rejects paths that resolve outside.
   */
  private static resolveAndValidateBinDir(configuredRoot: string): string {
    const resolved = path.resolve(configuredRoot);
    const resolvedData = path.resolve(dataPath);

    // Require the resolved path to be within the resolved data directory
    const relative = path.relative(resolvedData, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `tools.rootFolder ("${configuredRoot}") resolves outside the OffCKB data directory ` +
          `("${resolvedData}"). For security, tool binaries must be stored under the data path.`,
      );
    }

    return resolved;
  }

  private static validateVersion(version: string): void {
    if (!STRICT_VERSION_REGEX.test(version)) {
      throw new Error(`Invalid version format: "${version}". Expected format: vX.Y.Z (e.g., v0.1.3)`);
    }
  }

  private static getAssetName(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'darwin') {
      if (arch !== 'arm64') {
        throw new Error(`Unsupported architecture for macOS: ${arch}. Only Apple Silicon (arm64) is supported.`);
      }
      return 'ckb-tui-with-node-macos-aarch64.tar.gz';
    } else if (platform === 'linux') {
      if (arch !== 'x64') {
        throw new Error(`Unsupported architecture for Linux: ${arch}. Only x86_64 is supported.`);
      }
      return 'ckb-tui-with-node-linux-amd64.tar.gz';
    } else if (platform === 'win32') {
      if (arch !== 'x64') {
        throw new Error(`Unsupported architecture for Windows: ${arch}. Only x86_64 is supported.`);
      }
      return 'ckb-tui-with-node-windows-amd64.zip';
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  /**
   * Synchronously download and install the ckb-tui binary.
   * Uses spawnSync with array arguments (no shell interpolation) for security.
   */
  private static installSync(): void {
    const settings = readSettings();
    const version = settings.tools.ckbTui.version;

    this.validateVersion(version);

    const assetName = this.getAssetName();
    const binDir = this.resolveAndValidateBinDir(settings.tools.rootFolder);
    const binaryName = process.platform === 'win32' ? 'ckb-tui.exe' : 'ckb-tui';
    this.binaryPath = path.join(binDir, binaryName);

    const downloadUrl = `https://github.com/Officeyutong/ckb-tui/releases/download/${version}/${assetName}`;

    // Ensure the target directory exists
    fs.mkdirSync(binDir, { recursive: true });

    // Use a temp directory for atomic download & extraction
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-ckb-tui-'));
    const archivePath = path.join(tempDir, assetName);

    try {
      // 1. Download. Keep curl's own limit aligned with the outer spawnSync
      // timeout so the two never disagree about who gives up first.
      logger.info(`Downloading ckb-tui from ${downloadUrl}...`);
      const curlResult = spawnSync(
        'curl',
        ['-fsSL', '--max-time', String(DOWNLOAD_TIMEOUT_MS / 1000), '-o', archivePath, downloadUrl],
        {
          stdio: 'inherit',
          timeout: DOWNLOAD_TIMEOUT_MS,
        },
      );

      if (curlResult.error) {
        throw new Error(`Failed to download ckb-tui: ${curlResult.error.message}`);
      }
      if (curlResult.status !== 0) {
        throw new Error(`curl exited with code ${curlResult.status}`);
      }

      // 2. Verify checksum. Installation fails closed if no trusted digest exists.
      this.verifyChecksum(version, assetName, archivePath);

      // 3. Extract to temp directory
      logger.info('Extracting...');
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      this.extractArchive(archivePath, extractDir);

      // 4. Locate the extracted binary
      const extractedBinary = findFileInFolder(extractDir, binaryName);
      if (!extractedBinary) {
        throw new Error(`ckb-tui binary ("${binaryName}") was not found after extraction.`);
      }

      // 5. Move to the final location. renameSync is atomic but throws EXDEV
      // when the temp dir and the data path live on different filesystems
      // (common in containers), so fall back to copy+unlink there.
      try {
        fs.renameSync(extractedBinary, this.binaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          fs.copyFileSync(extractedBinary, this.binaryPath);
          fs.unlinkSync(extractedBinary);
        } else {
          throw error;
        }
      }

      // 6. Make executable on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(this.binaryPath, 0o755);
      }

      logger.info('ckb-tui installed successfully.');
    } catch (error) {
      // Reset cached path on failure so a subsequent call retries
      this.binaryPath = null;

      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        'Failed to download/install ckb-tui:',
        message,
        '\nPlease check your network connectivity, verify that the specified version exists in the releases, ' +
          'and ensure you have sufficient file system permissions.',
      );
      throw error;
    } finally {
      // Clean up the temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — temp dir will be cleaned by the OS eventually
      }
    }
  }

  /** Verify against an independently pinned digest. */
  private static verifyChecksum(version: string, assetName: string, archivePath: string): void {
    const pinnedHash = KNOWN_SHA256[version]?.[assetName];
    if (!pinnedHash) {
      throw new Error(
        `No trusted SHA-256 checksum is pinned for ckb-tui ${version} (${assetName}). ` +
          'Refusing to install an unverified binary.',
      );
    }
    this.assertChecksum(archivePath, assetName, pinnedHash);
  }

  private static assertChecksum(archivePath: string, assetName: string, expectedHash: string): void {
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(
        `SHA-256 checksum mismatch for ${assetName}.\n` +
          `Expected: ${expectedHash}\nActual:   ${actualHash}\n` +
          'The downloaded file may be corrupted or tampered with.',
      );
    }
    logger.info('SHA-256 checksum verified successfully.');
  }

  /**
   * Extract a downloaded archive to the given directory.
   * Uses AdmZip for .zip files (Node-native, no shell) and spawnSync with array
   * arguments for .tar.gz (no shell interpolation).
   */
  private static extractArchive(archivePath: string, extractDir: string): void {
    if (archivePath.endsWith('.tar.gz')) {
      const result = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        stdio: 'inherit',
        timeout: EXTRACT_TIMEOUT_MS,
      });
      if (result.error) {
        throw new Error(`tar extraction failed: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`tar exited with code ${result.status}`);
      }
    } else if (archivePath.endsWith('.zip')) {
      try {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(extractDir, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`ZIP extraction failed: ${message}`);
      }
    } else {
      throw new Error(`Unsupported archive format: ${path.extname(archivePath)}`);
    }
  }
}
