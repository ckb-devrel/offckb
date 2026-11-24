import ckbCli from '../../tools/ckb-cli.json';
import ckbDebugger from '../../tools/ckb-debugger.json';
import { NativeToolInstall } from './native';
import { parseToolDescriptor } from './tool-descriptor';

/**
 * First-party binary tool catalog: every descriptor file shipped in tools/
 * is one entry. The catalog is the only implicitly trusted binary source:
 * URLs, versions and SHA-256 digests are reviewed and pinned by the offckb
 * team with each release. Third parties are never listed here; users install
 * unadapted binaries locally with `offckb plugin install ./dir`.
 *
 * This index statically mirrors the tools/ directory so bundlers inline the
 * descriptors at build time; add one line per new descriptor file.
 */
interface CatalogFile {
  file: string;
  data: unknown;
}

const catalogFiles: CatalogFile[] = [
  { file: 'tools/ckb-cli.json', data: ckbCli },
  { file: 'tools/ckb-debugger.json', data: ckbDebugger },
];

export interface CatalogEntry {
  /** tools/ file this entry was read from. */
  file: string;
  command: string;
  /** Validated install shape, ready for installNativeTool. */
  install: NativeToolInstall;
}

function toCatalogEntry({ file, data }: CatalogFile): CatalogEntry {
  const tool = parseToolDescriptor(data, false);
  const metadata = data as { minVersion?: unknown; legacyInstallDir?: unknown };
  return {
    file,
    command: tool.command,
    install: {
      name: tool.name,
      version: tool.version,
      command: tool.command,
      description: tool.description,
      permissions: tool.permissions,
      execution: tool.execution,
      platforms: tool.platforms!,
      ...(typeof metadata.minVersion === 'string' ? { minVersion: metadata.minVersion } : {}),
      ...(typeof metadata.legacyInstallDir === 'string' ? { legacyInstallDir: metadata.legacyInstallDir } : {}),
    },
  };
}

export function catalogEntries(): Record<string, CatalogEntry> {
  const entries: Record<string, CatalogEntry> = {};
  for (const catalogFile of catalogFiles) {
    const entry = toCatalogEntry(catalogFile);
    if (Object.prototype.hasOwnProperty.call(entries, entry.command))
      throw new Error(`Duplicate catalog command ${entry.command} in ${catalogFile.file}`);
    entries[entry.command] = entry;
  }
  return entries;
}

export function catalogEntry(command: string): CatalogEntry | undefined {
  return catalogEntries()[command];
}
