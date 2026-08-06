/**
 * CKB Debugger Installer
 *
 * Installs the native `ckb-debugger` binary by downloading the prebuilt
 * release asset from the official ckb-standalone-debugger GitHub releases.
 *
 * Why prebuilt binaries instead of `cargo install`? Installing via cargo
 * requires a Rust toolchain and compiles the debugger from source, which is
 * slow and error-prone for most users. The upstream repository publishes
 * prebuilt binaries for Linux/macOS/Windows on every release, so offckb can
 * simply download the one that matches the current platform.
 *
 * The installer follows the same shape as CKBTui's install flow:
 *   1. Discover the latest release + matching asset via the GitHub API.
 *   2. Download the archive into a temp directory.
 *   3. Verify its SHA-256 digest when GitHub provides one (fail closed).
 *   4. Extract and publish the binary atomically under tools.rootFolder.
 *   5. Put a `ckb-debugger` shim next to the offckb binary so generated
 *      projects can find it on PATH.
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { Request } from '../util/request';
import { readSettings, dataPath } from '../cfg/setting';
import { logger } from '../util/logger';
import { findFileInFolder } from '../util/fs';

const DEBUGGER_REPO = 'nervosnetwork/ckb-standalone-debugger';
const LATEST_RELEASE_API = `https://api.github.com/repos/${DEBUGGER_REPO}/releases/latest`;

const EXTRACT_TIMEOUT_MS = 60_000;

export interface CkbDebuggerReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  /** "sha256:<hex>" digest reported by the GitHub API for the asset. */
  digest?: string;
}

export interface CkbDebuggerRelease {
  tagName: string;
  assets: CkbDebuggerReleaseAsset[];
}

export interface CkbDebuggerInstallResult {
  binaryPath: string;
  version: string | null;
  /** True when a usable binary was already installed and no download happened. */
  alreadyInstalled: boolean;
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'ckb-debugger.exe' : 'ckb-debugger';
}

/** Numeric (not lexicographic) comparison against a required minimum version. */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parse = (v: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(version);
  const b = parse(minVersion);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return true;
}

/**
 * Pick the release asset matching the current platform/architecture.
 * Names are matched tolerantly so that small upstream naming changes do not
 * break the installer; archive assets (zip/tar.gz) are preferred over bare
 * executables.
 */
export function selectAsset(
  assets: CkbDebuggerReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): CkbDebuggerReleaseAsset | null {
  const matches = assets.filter((asset) => assetMatchesPlatform(asset.name, platform, arch));
  if (matches.length === 0) {
    return null;
  }
  const archive = matches.find((asset) => /\.(tar\.gz|tgz|zip)$/i.test(asset.name));
  return archive || matches[0];
}

function assetMatchesPlatform(name: string, platform: NodeJS.Platform, arch: string): boolean {
  const lower = name.toLowerCase();
  switch (platform) {
    case 'win32':
      return arch === 'x64' && /win/i.test(lower);
    case 'linux':
      return (
        arch === 'x64' &&
        /linux/i.test(lower) &&
        (lower.includes('x86_64') || lower.includes('amd64') || lower.includes('x64'))
      );
    case 'darwin':
      if (arch === 'arm64') {
        return /(macos|darwin)/i.test(lower) && (lower.includes('aarch64') || lower.includes('arm64'));
      }
      if (arch === 'x64') {
        return (
          /(macos|darwin)/i.test(lower) &&
          (lower.includes('x86_64') || lower.includes('amd64') || lower.includes('x64'))
        );
      }
      return false;
    default:
      return false;
  }
}

export class CKBDebuggerInstaller {
  /**
   * Install (or refresh) the native ckb-debugger binary for this platform.
   * Throws on any failure; callers that can degrade (e.g. the create flow)
   * should catch the error.
   */
  static async install(): Promise<CkbDebuggerInstallResult> {
    const binaryPath = this.getInstalledBinaryPath();

    // Already installed and satisfies the required minimum version: nothing
    // to download, just make sure the PATH shim is in place.
    if (fs.existsSync(binaryPath)) {
      const version = this.getVersionFromBinary(binaryPath);
      if (version && this.satisfiesMinVersion(version)) {
        this.ensurePathShim(binaryPath);
        logger.info(`ckb-debugger ${version} is already installed at ${binaryPath}.`);
        return { binaryPath, version, alreadyInstalled: true };
      }
      if (version) {
        logger.info(
          `The installed ckb-debugger (${version}) is older than the required minimum ` +
            `(${this.minVersion()}); installing the latest release...`,
        );
      } else {
        logger.info('The installed ckb-debugger looks stale; installing the latest release...');
      }
    }

    fs.mkdirSync(this.getInstallDir(), { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-ckb-debugger-'));
    try {
      // 1. Discover the latest release and the matching asset.
      logger.info(`Looking up the latest ckb-debugger release from ${DEBUGGER_REPO}...`);
      const release = await this.fetchLatestRelease();
      const asset = selectAsset(release.assets, process.platform, process.arch);
      if (!asset) {
        const names = release.assets.map((a) => a.name).join(', ') || 'none';
        throw new Error(
          `No ckb-debugger release asset matches ${process.platform}/${process.arch}. ` + `Available assets: ${names}`,
        );
      }
      logger.info(`Found ${release.tagName} · ${asset.name}`);

      // 2. Download the archive.
      const archivePath = path.join(tempDir, asset.name);
      await this.download(asset.browserDownloadUrl, archivePath);

      // 3. Verify the digest when GitHub provides one.
      this.verifyChecksum(asset, archivePath);

      // 4. Extract to a temp directory.
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      this.extractArchive(archivePath, extractDir);

      // 5. Locate the extracted binary.
      const extractedBinary = findFileInFolder(extractDir, getBinaryName());
      if (!extractedBinary) {
        throw new Error(`ckb-debugger binary ("${getBinaryName()}") was not found after extraction.`);
      }

      // 6. Publish atomically so a failed install never leaves a partial binary.
      this.publishExtractedBinary(extractedBinary, binaryPath);

      // 7. Make executable and expose it on PATH.
      if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, 0o755);
      }
      this.ensurePathShim(binaryPath);

      const version = this.getVersionFromBinary(binaryPath);
      logger.info(`✅ ckb-debugger installed successfully at ${binaryPath}${version ? ` (version ${version})` : ''}.`);
      logger.info('   To uninstall, remove the binary and the ckb-debugger shim next to the offckb binary.');
      return { binaryPath, version, alreadyInstalled: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        'Failed to install ckb-debugger:',
        message,
        '\nPlease check your network connectivity and try again with: offckb install ckb-debugger',
      );
      throw error;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS will reap the temp dir eventually.
      }
    }
  }

  /** Directory that holds the installed ckb-debugger binary. */
  static getInstallDir(): string {
    const settings = readSettings();
    const root = this.resolveAndValidateBinDir(settings.tools.rootFolder);
    return path.join(root, 'ckb-debugger');
  }

  /** Full path of the installed ckb-debugger binary. */
  static getInstalledBinaryPath(): string {
    return path.join(this.getInstallDir(), getBinaryName());
  }

  // --- private helpers ---

  private static minVersion(): string {
    return readSettings().tools.ckbDebugger.minVersion;
  }

  private static satisfiesMinVersion(version: string): boolean {
    return isVersionAtLeast(version, this.minVersion());
  }

  private static getVersionFromBinary(binaryPath: string): string | null {
    try {
      const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' });
      if (result.status !== 0) {
        return null;
      }
      const match = /(\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)/.exec(`${result.stdout}${result.stderr || ''}`);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private static async fetchLatestRelease(): Promise<CkbDebuggerRelease> {
    const response = await Request.send(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'offckb' },
    });
    const json = (await response.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>;
    };
    const tagName = json.tag_name || '';
    const assets = (json.assets || [])
      .filter((asset) => asset.name && asset.browser_download_url)
      .map((asset) => ({
        name: asset.name as string,
        browserDownloadUrl: asset.browser_download_url as string,
        digest: asset.digest,
      }));
    if (!tagName || assets.length === 0) {
      throw new Error(`The GitHub API did not return a usable latest release for ${DEBUGGER_REPO}.`);
    }
    return { tagName, assets };
  }

  private static async download(url: string, targetPath: string): Promise<void> {
    logger.info(`Downloading ${url} ...`);
    const response = await Request.send(url);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
  }

  /** Verify against the SHA-256 digest reported by the GitHub API, if any. */
  private static verifyChecksum(asset: CkbDebuggerReleaseAsset, archivePath: string): void {
    if (!asset.digest) {
      logger.warn(`GitHub did not report a SHA-256 digest for ${asset.name}; skipping checksum verification.`);
      return;
    }
    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim());
    if (!match) {
      logger.warn(`GitHub reported an unexpected digest format for ${asset.name}; skipping checksum verification.`);
      return;
    }
    const expected = match[1].toLowerCase();
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (actual !== expected) {
      throw new Error(
        `SHA-256 checksum mismatch for ${asset.name}.\n` +
          `Expected: ${expected}\nActual:   ${actual}\n` +
          'The downloaded file may be corrupted or tampered with.',
      );
    }
    logger.info('SHA-256 checksum verified successfully.');
  }

  private static extractArchive(archivePath: string, extractDir: string): void {
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      // --force-local: on Windows, GNU tar would otherwise interpret the
      // drive prefix in "C:\...\file.tar.gz" as a remote host and fail.
      const result = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir, '--force-local'], {
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

  /**
   * Atomically publish the extracted binary to the install path. A directory
   * occupying the install path is set aside (never deleted) and restored if
   * publishing fails; cross-filesystem temp dirs fall back to a staged copy.
   */
  private static publishExtractedBinary(extractedBinary: string, binaryPath: string): void {
    let dirBackupPath: string | null = null;
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(binaryPath);
    } catch {
      existing = null;
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
      } finally {
        fs.rmSync(stagingPath, { force: true });
      }
    }
  }

  /**
   * Write a `ckb-debugger` shim next to the offckb binary so generated
   * projects that shell out to `ckb-debugger` resolve to the installed
   * native binary. When offckb is not on PATH (unusual), skip with a warning.
   */
  private static ensurePathShim(binaryPath: string): string | null {
    const isWindows = process.platform === 'win32';
    const result = spawnSync(isWindows ? 'where' : 'which', ['offckb'], { encoding: 'utf8' });
    const offckbPath = isWindows ? result.stdout.trim().split('\n')[0] : result.stdout.trim();
    if (!offckbPath) {
      logger.warn(
        'Could not find the offckb binary in PATH, so no ckb-debugger shim was created. ' +
          'Projects that call `ckb-debugger` directly will need it added to PATH manually.',
      );
      return null;
    }

    const binName = isWindows ? 'ckb-debugger.cmd' : 'ckb-debugger';
    const targetPath = path.join(path.dirname(offckbPath), binName);
    const content = isWindows ? `@echo off\r\n"${binaryPath}" %*\r\n` : `#!/bin/sh\nexec "${binaryPath}" "$@"\n`;

    try {
      fs.writeFileSync(targetPath, content);
      if (!isWindows) {
        fs.chmodSync(targetPath, 0o755);
      }
      logger.info(`✅ ckb-debugger shim updated: ${targetPath}`);
      return targetPath;
    } catch (error) {
      // A missing shim must not fail an otherwise successful install: the
      // binary is already in place and offckb can use it directly.
      logger.warn(
        `Could not write the ckb-debugger shim at ${targetPath}: ${(error as Error).message}. ` +
          'Projects that call `ckb-debugger` directly will need it added to PATH manually.',
      );
      return null;
    }
  }

  /** Resolve and validate that tools.rootFolder stays under the OffCKB data path. */
  private static resolveAndValidateBinDir(configuredRoot: string): string {
    const resolved = path.resolve(configuredRoot);
    const resolvedData = path.resolve(dataPath);
    const relative = path.relative(resolvedData, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `tools.rootFolder ("${configuredRoot}") resolves outside the OffCKB data directory ` +
          `("${resolvedData}"). For security, tool binaries must be stored under the data path.`,
      );
    }
    return resolved;
  }
}
