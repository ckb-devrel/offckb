import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertSupportedFnnVersion,
  buildFnnDownloadUrl,
  KNOWN_FNN_SHA256,
  SUPPORTED_FNN_VERSIONS,
  verifyFnnPackageChecksum,
} from '../src/fiber/install';

/**
 * FNN release integrity: downloads are verified against pinned SHA-256
 * digests before extraction, and fail closed when no pin exists.
 */
describe('assertSupportedFnnVersion', () => {
  it('accepts every supported version', () => {
    for (const version of SUPPORTED_FNN_VERSIONS) {
      expect(() => assertSupportedFnnVersion(version)).not.toThrow();
    }
  });

  it('rejects an untested version and points at --binary-path', () => {
    expect(() => assertSupportedFnnVersion('0.8.0')).toThrow('--binary-path');
  });
});

describe('buildFnnDownloadUrl', () => {
  it('targets the pinned GitHub release and a package with a pinned digest', () => {
    for (const version of SUPPORTED_FNN_VERSIONS) {
      const url = buildFnnDownloadUrl(version);
      expect(url).toMatch(
        new RegExp(`^https://github\\.com/nervosnetwork/fiber/releases/download/v${version}/fnn_v${version}-[a-z0-9_-]+\\.tar\\.gz$`),
      );
      const packageName = url.split('/').pop()!.replace(/\.tar\.gz$/, '');
      // The package for THIS platform must have a pinned digest, or installs
      // here would fail closed at verification time.
      expect(KNOWN_FNN_SHA256[version]?.[packageName]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('verifyFnnPackageChecksum', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fnn-checksum-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete KNOWN_FNN_SHA256['9.9.9-test'];
  });

  function writeTarball(content: string): string {
    const file = path.join(tempDir, 'pkg.tar.gz');
    fs.writeFileSync(file, content);
    return file;
  }

  it('accepts a tarball whose digest matches the pin', () => {
    const file = writeTarball('fnn release bytes');
    const digest = createHash('sha256').update('fnn release bytes').digest('hex');
    KNOWN_FNN_SHA256['9.9.9-test'] = { 'fnn_v9.9.9-test-x86_64-linux-portable': digest };
    expect(() => verifyFnnPackageChecksum('9.9.9-test', 'fnn_v9.9.9-test-x86_64-linux-portable', file)).not.toThrow();
  });

  it('rejects a tarball whose digest differs from the pin', () => {
    const file = writeTarball('tampered bytes');
    const digest = createHash('sha256').update('honest bytes').digest('hex');
    KNOWN_FNN_SHA256['9.9.9-test'] = { 'fnn_v9.9.9-test-x86_64-linux-portable': digest };
    expect(() => verifyFnnPackageChecksum('9.9.9-test', 'fnn_v9.9.9-test-x86_64-linux-portable', file)).toThrow(
      'checksum mismatch',
    );
  });

  it('fails closed when no pin exists for the version', () => {
    const file = writeTarball('fnn release bytes');
    expect(() => verifyFnnPackageChecksum('9.9.9-test', 'fnn_v9.9.9-test-x86_64-linux-portable', file)).toThrow(
      'No trusted SHA-256 checksum is pinned',
    );
  });

  it('fails closed when no pin exists for the package', () => {
    const file = writeTarball('fnn release bytes');
    KNOWN_FNN_SHA256['9.9.9-test'] = { 'some-other-package': 'x'.repeat(64) };
    expect(() => verifyFnnPackageChecksum('9.9.9-test', 'fnn_v9.9.9-test-x86_64-linux-portable', file)).toThrow(
      'No trusted SHA-256 checksum is pinned',
    );
  });

  it('pins a well-formed digest for every package of every supported version', () => {
    // The five packages buildFnnPackageName can produce across the supported
    // platform/arch combinations; a version bump that forgets the pins fails here.
    const packageNames = (version: string) => [
      `fnn_v${version}-x86_64-linux-portable`,
      `fnn_v${version}-aarch64-linux-portable`,
      `fnn_v${version}-x86_64-darwin-portable`,
      `fnn_v${version}-aarch64-darwin-portable`,
      `fnn_v${version}-x86_64-windows`,
    ];
    for (const version of SUPPORTED_FNN_VERSIONS) {
      for (const name of packageNames(version)) {
        expect(KNOWN_FNN_SHA256[version]?.[name]).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
