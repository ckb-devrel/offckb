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
// offckb makes the default installation verifiable even though ckb-tui v0.1.4
// did not upload a checksums-sha256.txt asset.
const KNOWN_SHA256: Record<string, Record<string, string>> = {
  'v0.1.4': {
    'ckb-tui-with-node-linux-amd64.tar.gz': 'eaed2cfbd55c4ee78493200bf33b5b120ec2625df4e7041b048cd87d51801cbd',
    'ckb-tui-with-node-macos-aarch64.tar.gz': '911aa3f1266fd333d2566e798df888ffb105b35da7d9328d7b715f3be7adc246',
    'ckb-tui-with-node-windows-amd64.zip': 'aab24826e0951188f72ddc1c128148899c54237dc9cc4bd5929038504cdd0dfa',
  },
  'v0.1.3': {
    'ckb-tui-with-node-linux-amd64.tar.gz': '33455cefe2c016149fa8fa3abde7960b348d4606afef9279d787ac8a8b59956f',
    'ckb-tui-with-node-macos-aarch64.tar.gz': 'de18107ec179ced03608da956013e38ae82e6c1fae588f12c17d138ee6ee072c',
    'ckb-tui-with-node-windows-amd64.zip': '749d8e09fd5d23fc8af12892b7d197add5aae004f7438678023e4a973f3fd58b',
  },
};

// Digests of the extracted ckb-tui binaries, keyed the same way as
// KNOWN_SHA256. ensureInstalled uses these to recognize a stale or foreign
// binary at the install path: ckb-tui's own `--version` output lags its
// release tag (the v0.1.4 binary still reports 0.1.2), so the on-disk digest
// is the only reliable identity. Versions without a pinned binary digest fall
// back to presence-only detection (install-time archive verification still
// applies).
const KNOWN_BINARY_SHA256: Record<string, Record<string, string>> = {
  'v0.1.4': {
    'ckb-tui-with-node-linux-amd64.tar.gz': 'e2c31db99e81ea6ae0455796464a671c10bf8fe74615c40b995c34ff57630b43',
    'ckb-tui-with-node-macos-aarch64.tar.gz': 'a9748cf1581568cf7409193d5cb851ea956a82a84fd69c08513fee351a8ad7fc',
    'ckb-tui-with-node-windows-amd64.zip': '2ed73cd9095b2f9b947377736e8013985f48a8c1e696a3dd78033af658aab612',
  },
  'v0.1.3': {
    'ckb-tui-with-node-linux-amd64.tar.gz': '2daca14ea8eba2a7888d1223c387a8d8e0846dafc424cd66891d4d96f4720005',
    'ckb-tui-with-node-macos-aarch64.tar.gz': 'e21971d59edce7d5d590ac05314d67343fb70187a73a8dd19af87a71e1fe34e0',
    'ckb-tui-with-node-windows-amd64.zip': 'b2fce1c161158e8a2dd5b5c5a796091f3c668e57e57b8dd403053ceef1301716',
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
   * does not already exist or does not match the configured version's
   * pinned digest (e.g. a stale binary from an older default release).
   */
  static ensureInstalled(): string {
    const binaryPath = this.getBinaryPath();
    if (binaryPath && this.installedBinaryMatches(binaryPath)) {
      return binaryPath;
    }
    if (binaryPath && fs.existsSync(binaryPath)) {
      logger.info('The installed ckb-tui does not match the configured release; reinstalling...');
    }

    // Re-install. The existing binary is deliberately left in place: installSync
    // downloads, verifies, and extracts into a temp directory and only then
    // publishes with an atomic rename, so a failed reinstall keeps the previous
    // binary instead of stranding the user with none.
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
   * Verifies an existing on-disk binary against the configured version's
   * pinned binary digest. Returns true when the binary may be kept: either it
   * matches the digest, or the configured version has no pinned binary digest
   * (presence-only fallback; install-time archive verification still applies).
   * Missing, unreadable, or non-regular paths (e.g. a directory or FIFO) count
   * as a mismatch so the reinstall flow runs instead of crashing with a raw fs
   * error, blocking forever on a special file, or failing later at spawn time.
   */
  private static installedBinaryMatches(binaryPath: string): boolean {
    const settings = readSettings();
    const expected = KNOWN_BINARY_SHA256[settings.tools.ckbTui.version]?.[this.getAssetName()];
    try {
      // Require a regular file first: opening a FIFO or device for reading
      // would block indefinitely, before any digest comparison could run.
      if (!fs.statSync(binaryPath).isFile()) {
        return false;
      }
      // Metadata alone does not prove readability; an unreadable binary must
      // flow into the reinstall path (which republishes with correct modes).
      fs.accessSync(binaryPath, fs.constants.R_OK);
      if (!expected) {
        return true;
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
      return actual === expected;
    } catch {
      return false;
    }
  }

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
      throw new Error(`Invalid version format: "${version}". Expected format: vX.Y.Z (e.g., v0.1.4)`);
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

      // 5. Publish the verified binary. publishExtractedBinary owns the edge
      // cases: a directory occupying the install path is set aside (and
      // restored on failure), and cross-filesystem temp dirs fall back to a
      // staged copy next to the target.
      this.publishExtractedBinary(extractedBinary, this.binaryPath);

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

  /**
   * Atomically publish the extracted binary to the install path.
   *
   * A directory occupying the install path (e.g. from a botched manual
   * extraction) cannot be replaced by a file rename — without this handling
   * the reinstall would fail on every attempt — so it is first set aside with
   * a plain rename (its contents are never deleted) and restored if publishing
   * fails. On success the aside directory is left in place and its location
   * logged, so nothing the user put there is silently destroyed.
   */
  private static publishExtractedBinary(extractedBinary: string, binaryPath: string): void {
    let dirBackupPath: string | null = null;
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(binaryPath);
    } catch {
      existing = null; // Nothing at the install path.
    }
    if (existing?.isDirectory()) {
      dirBackupPath = `${binaryPath}.backup-${process.pid}-${Date.now()}`;
      fs.renameSync(binaryPath, dirBackupPath);
    }

    try {
      this.renameIntoPlace(extractedBinary, binaryPath);
    } catch (error) {
      if (dirBackupPath) {
        try {
          fs.renameSync(dirBackupPath, binaryPath);
        } catch {
          // Best effort: the original directory remains at its backup path.
        }
      }
      throw error;
    }

    if (dirBackupPath) {
      logger.info(`A directory unexpectedly occupied ${binaryPath}; moved it aside to ${dirBackupPath}.`);
    }
  }

  /**
   * renameSync is atomic but throws EXDEV when source and target live on
   * different filesystems (common in containers, where os.tmpdir() and the
   * data path differ). In that case stage the copy next to the target and
   * publish it with a rename, so a concurrent ensureInstalled() never sees a
   * partially copied binary at the final path.
   */
  private static renameIntoPlace(source: string, target: string): void {
    try {
      fs.renameSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      const stagingPath = path.join(path.dirname(target), `.${path.basename(target)}.staging-${process.pid}`);
      try {
        fs.copyFileSync(source, stagingPath);
        fs.renameSync(stagingPath, target);
        fs.unlinkSync(source);
      } finally {
        fs.rmSync(stagingPath, { force: true });
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
