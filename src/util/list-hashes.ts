import { execSync } from 'child_process';
import { getCKBBinaryPath, readSettings } from '../cfg/setting';
import { encodeBinPathForTerminal } from './encoding';
import { H256 } from '../type/base';

export interface SystemCell {
  path: string;
  tx_hash: H256;
  index: number;
  data_hash: H256;
  type_hash?: H256;
}

export interface DepGroupCell {
  included_cells: string[];
  tx_hash: H256;
  index: number;
}

export interface SpecHashes {
  spec_hash: H256;
  genesis: H256;
  cellbase: H256;
  system_cells: SystemCell[];
  dep_groups: DepGroupCell[];
}

export interface ListHashes {
  offckb: SpecHashes;
}

export function getDevnetListHashes(version?: string): string | null {
  const settings = readSettings();
  const ckbVersion = version || settings.bins.defaultCKBVersion;
  const ckbBinPath = encodeBinPathForTerminal(getCKBBinaryPath(ckbVersion));
  const devnetPath = encodeBinPathForTerminal(settings.devnet.configPath);
  const cmd = `${ckbBinPath} list-hashes  -C ${devnetPath}`;
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
    });
    return output;
  } catch (error) {
    console.error('Error running dependency binary:', error);
    return null;
  }
}
