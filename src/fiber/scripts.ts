import { resolveDevnetSystemScripts } from '../scripts/private';
import { SystemScript, SystemScriptName, SystemScriptsRecord } from '../scripts/type';
import { udtIssuerLockHash } from './accounts';

export interface FnnCellDep {
  cell_dep: {
    out_point: {
      tx_hash: string;
      // ckb_jsonrpc_types serializes uint32 as hex strings.
      index: string;
    };
    dep_type: 'code';
  };
}

export interface FnnFiberScript {
  name: 'FundingLock' | 'CommitmentLock';
  script: {
    code_hash: string;
    hash_type: string;
    args: string;
  };
  cell_deps: FnnCellDep[];
}

export interface FnnUdtInfo {
  name: string;
  script: {
    code_hash: string;
    hash_type: string;
    // FNN treats UDT args as a regex matched against the candidate cell's
    // type args; anchor the full issuer-derived args, never a 0x.* wildcard.
    args: string;
  };
  cell_deps: FnnCellDep[];
}

export interface FiberChainScripts {
  genesisHash: string;
  fiberScripts: FnnFiberScript[];
  udtWhitelist: FnnUdtInfo[];
}

function codeCellDep(script: SystemScript): FnnCellDep {
  const dep = script.script.cellDeps.find((d) => d.cellDep.depType === 'code');
  if (!dep) {
    throw new Error(`System script ${script.name} has no code cell dep in list-hashes output.`);
  }
  return {
    cell_dep: {
      out_point: {
        tx_hash: dep.cellDep.outPoint.txHash,
        index: `0x${dep.cellDep.outPoint.index.toString(16)}`,
      },
      dep_type: 'code',
    },
  };
}

function requireScript(scripts: SystemScriptsRecord, name: SystemScriptName): SystemScript {
  const script = scripts[name];
  if (script == null) {
    throw new Error(
      `The devnet chain spec does not include the system script "${name}". Run \`offckb clean\` to rebuild the devnet.`,
    );
  }
  return script;
}

export class FiberContractsMissingError extends Error {
  public readonly missing: string[];
  constructor(missing: string[]) {
    super(`The devnet chain spec does not include the Fiber contracts: ${missing.join(', ')}.`);
    this.name = 'FiberContractsMissingError';
    this.missing = missing;
  }
}

/**
 * Build the FNN `fiber.scripts` and `ckb.udt_whitelist` sections from one
 * `ckb list-hashes` run against the actual devnet directory. FundingLock and
 * CommitmentLock each depend on their own contract cell plus the shared auth
 * cell; both test UDTs are issued by built-in account 19, so their whitelist
 * args anchor to that account's lock hash.
 */
export function resolveFiberChainScripts(): FiberChainScripts {
  const resolved = resolveDevnetSystemScripts();
  if (resolved == null) {
    throw new Error(
      'Failed to read the devnet chain spec hashes (ckb list-hashes). Is the CKB binary installed and the devnet initialized?',
    );
  }
  const scripts = resolved.scripts;

  const required = [SystemScriptName.auth, SystemScriptName.funding_lock, SystemScriptName.commitment_lock];
  const missing = required.filter((name) => scripts[name] == null);
  if (missing.length > 0) {
    throw new FiberContractsMissingError(missing);
  }

  const auth = requireScript(scripts, SystemScriptName.auth);
  const fundingLock = requireScript(scripts, SystemScriptName.funding_lock);
  const commitmentLock = requireScript(scripts, SystemScriptName.commitment_lock);
  const sudt = requireScript(scripts, SystemScriptName.sudt);
  const xudt = requireScript(scripts, SystemScriptName.xudt);

  const authDep = codeCellDep(auth);
  const fiberScripts: FnnFiberScript[] = [
    {
      name: 'FundingLock',
      script: {
        code_hash: fundingLock.script.codeHash,
        hash_type: fundingLock.script.hashType,
        args: '0x',
      },
      cell_deps: [codeCellDep(fundingLock), authDep],
    },
    {
      name: 'CommitmentLock',
      script: {
        code_hash: commitmentLock.script.codeHash,
        hash_type: commitmentLock.script.hashType,
        args: '0x',
      },
      cell_deps: [codeCellDep(commitmentLock), authDep],
    },
  ];

  const issuerArgsPattern = `^${udtIssuerLockHash()}$`;
  const udtWhitelist: FnnUdtInfo[] = [
    {
      name: 'sudt',
      script: {
        code_hash: sudt.script.codeHash,
        hash_type: sudt.script.hashType,
        args: issuerArgsPattern,
      },
      cell_deps: [codeCellDep(sudt)],
    },
    {
      name: 'xudt',
      script: {
        code_hash: xudt.script.codeHash,
        hash_type: xudt.script.hashType,
        args: issuerArgsPattern,
      },
      cell_deps: [codeCellDep(xudt)],
    },
  ];

  return { genesisHash: resolved.genesisHash, fiberScripts, udtWhitelist };
}
