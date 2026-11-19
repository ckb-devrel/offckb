import { readSettings } from '../cfg/setting';
import { NativeRelease } from './manifest';

/**
 * First-party binary tool descriptors, built into offckb. The catalog is the
 * only implicitly trusted source: repo, asset naming and checksum policy are
 * maintained by the offckb team with each release. Third-party binary tools
 * are never listed here; they require an explicit trusted-source approval
 * (see store.ts).
 */
export interface CatalogEntry {
  name: string;
  command: string;
  description: string;
  binaryName: string;
  release: NativeRelease;
  minVersion?: string;
  /**
   * Pre-plugin installations lived at <tools.rootFolder>/<command>. On first
   * install the managed binary is adopted from here instead of re-downloaded,
   * so existing users keep their version and no network is required.
   */
  legacyInstallDir?: string;
}

export function catalogEntries(): Record<string, CatalogEntry> {
  const settings = readSettings();
  return {
    'ckb-debugger': {
      name: 'ckb-debugger',
      command: 'ckb-debugger',
      description: 'CKB standalone debugger (native binary)',
      binaryName: 'ckb-debugger',
      release: {
        repo: 'nervosnetwork/ckb-standalone-debugger',
        // Upstream names assets ckb-debugger_<tag>_<target>.tar.gz with a
        // sibling ckb-debugger_<tag>_<target>-sha256.txt (no .tar.gz infix).
        asset: 'ckb-debugger_{tag}_{target}.tar.gz',
        checksum: 'ckb-debugger_{tag}_{target}-sha256.txt',
      },
      minVersion: settings.tools.ckbDebugger.minVersion,
      legacyInstallDir: 'ckb-debugger',
    },
  };
}

export function catalogEntry(name: string): CatalogEntry | undefined {
  const entry = catalogEntries()[name];
  return entry?.name === name ? entry : undefined;
}
