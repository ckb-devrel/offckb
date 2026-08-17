import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertSupportedFnnVersion,
  buildFnnDownloadUrl,
  buildFnnPackageName,
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

describe('buildFnnPackageName', () => {
  it('names the linux/darwin packages for both supported architectures', () => {
    expect(buildFnnPackageName('0.9.0-rc7', 'linux', 'x64')).toBe('fnn_v0.9.0-rc7-x86_64-linux-portable');
    expect(buildFnnPackageName('0.9.0-rc7', 'linux', 'arm64')).toBe('fnn_v0.9.0-rc7-aarch64-linux-portable');
    expect(buildFnnPackageName('0.9.0-rc7', 'darwin', 'x64')).toBe('fnn_v0.9.0-rc7-x86_64-darwin-portable');
    expect(buildFnnPackageName('0.9.0-rc7', 'darwin', 'arm64')).toBe('fnn_v0.9.0-rc7-aarch64-darwin-portable');
  });

  it('maps every Windows arch to the only published x86_64 package', () => {
    // FNN publishes no aarch64 Windows build; Windows on ARM runs x64 under
    // emulation, so this mapping is intentional.
    expect(buildFnnPackageName('0.9.0-rc7', 'win32', 'x64')).toBe('fnn_v0.9.0-rc7-x86_64-windows');
    expect(buildFnnPackageName('0.9.0-rc7', 'win32', 'arm64')).toBe('fnn_v0.9.0-rc7-x86_64-windows');
  });

  it('rejects unsupported architectures instead of silently mapping to x86_64', () => {
    expect(() => buildFnnPackageName('0.9.0-rc7', 'linux', 'ppc64')).toThrow('Unsupported CPU architecture');
    expect(() => buildFnnPackageName('0.9.0-rc7', 'darwin', 'ia32')).toThrow('Unsupported CPU architecture');
  });

  it('rejects unsupported operating systems', () => {
    expect(() => buildFnnPackageName('0.9.0-rc7', 'freebsd' as NodeJS.Platform, 'x64')).toThrow(
      'Unsupported operating system',
    );
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
    // Every platform/arch combination the installer can resolve; a version
    // bump that forgets the pins fails here. Names come from the production
    // helper so the test cannot drift from the real naming scheme.
    const combinations: Array<[NodeJS.Platform, string]> = [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['win32', 'x64'],
    ];
    for (const version of SUPPORTED_FNN_VERSIONS) {
      for (const [platform, arch] of combinations) {
        const name = buildFnnPackageName(version, platform, arch);
        expect(KNOWN_FNN_SHA256[version]?.[name]).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
