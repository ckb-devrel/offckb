import { ccc, CellDepInfoLike, KnownScript, Script } from '@ckb-ccc/core';
import { readSettings } from '../cfg/setting';
import { getDevnetListHashes, ListHashes, SpecHashes } from '../util/list-hashes';
import { logger } from '../util/logger';
import { TYPE_ID_SCRIPT, identifyPublicChainByGenesisHash, PublicChainIdentity } from './const';
import { MAINNET_SYSTEM_SCRIPTS, TESTNET_SYSTEM_SCRIPTS } from './public';
import { SystemScriptsRecord, SystemScriptName, SystemScript } from './type';
import toml from '@iarna/toml';
import { extractScriptNameFromPath, systemCellToScriptInfo } from './util';

export interface DevnetSystemScripts {
  scripts: SystemScriptsRecord;
  // Which well-known chain the devnet's genesis belongs to, or null for a
  // pure/custom devnet. A forked devnet self-identifies via its genesis hash.
  forkedFrom: PublicChainIdentity | null;
  genesisHash: string;
}

function buildSystemScriptsFromSpecHashes(chainSpecHashes: SpecHashes): SystemScriptsRecord {
  const systemScriptArray = chainSpecHashes.system_cells
    .map((cell) => {
      // Extract the file name from the path using the helper function
      const name = extractScriptNameFromPath(cell.path);

      const depGroupIndex = chainSpecHashes.dep_groups.findIndex((depGroup) =>
        depGroup.included_cells.includes(cell.path),
      );
      const depType = depGroupIndex === -1 ? 'code' : 'depGroup';
      const depGroup =
        depGroupIndex === -1
          ? undefined
          : {
              txHash: chainSpecHashes.dep_groups[depGroupIndex].tx_hash,
              index: chainSpecHashes.dep_groups[depGroupIndex].index,
            };
      const scriptInfo = systemCellToScriptInfo({ cell, depType, depGroup });
      return {
        name,
        file: cell.path,
        script: scriptInfo,
      };
    })
    .filter((s) => s.name != 'secp256k1_data');
  const systemScripts: SystemScriptsRecord = systemScriptArray.reduce<SystemScriptsRecord>((acc, item) => {
    const key = item.name as unknown as SystemScriptName;
    acc[key] = item as unknown as SystemScript;
    return acc;
  }, {} as SystemScriptsRecord);

  // some special case fixes
  // eg: omnilock also requires the deps of secp256k1-sigHashAll
  systemScripts.omnilock?.script.cellDeps.push(systemScripts.secp256k1_blake160_sighash_all!.script.cellDeps[0]);

  // add built-in type_id script
  systemScripts.type_id = TYPE_ID_SCRIPT;

  return systemScripts;
}

// `ckb list-hashes` only reports what the chain spec declares in genesis.
// Post-genesis deployments (sudt/xudt/omnilock/spore on mainnet and testnet)
// can never appear there, so for a forked devnet we fill the gaps from the
// well-known static records of the chain the genesis belongs to. Genesis
// scripts always come from list-hashes — the chain's own spec wins.
function supplementFromStaticRecord(scripts: SystemScriptsRecord, staticRecord: SystemScriptsRecord): void {
  for (const [name, script] of Object.entries(staticRecord)) {
    const key = name as SystemScriptName;
    if (scripts[key] == null && script != null) {
      // deep clone so callers can never mutate the shared static record
      scripts[key] = JSON.parse(JSON.stringify(script)) as SystemScript;
    }
  }
}

export function resolveDevnetSystemScripts(): DevnetSystemScripts | null {
  const settings = readSettings();
  const listHashesString = getDevnetListHashes(settings.bins.defaultCKBVersion);
  if (!listHashesString) {
    logger.info(`list-hashes not found!`);
    return null;
  }

  const listHashes = toml.parse(listHashesString) as unknown as ListHashes;
  const chainSpecHashes: SpecHashes | null = Object.values(listHashes)[0];
  if (chainSpecHashes == null) {
    throw new Error(`invalid chain spec hashes file ${listHashesString}`);
  }

  const scripts = buildSystemScriptsFromSpecHashes(chainSpecHashes);
  const forkedFrom = identifyPublicChainByGenesisHash(chainSpecHashes.genesis);
  if (forkedFrom === 'mainnet') {
    supplementFromStaticRecord(scripts, MAINNET_SYSTEM_SCRIPTS);
  } else if (forkedFrom === 'testnet') {
    supplementFromStaticRecord(scripts, TESTNET_SYSTEM_SCRIPTS);
  }

  return { scripts, forkedFrom, genesisHash: chainSpecHashes.genesis };
}

export function getDevnetSystemScriptsFromListHashes(): SystemScriptsRecord | null {
  return resolveDevnetSystemScripts()?.scripts ?? null;
}

export function toCCCKnownScripts(scripts: SystemScriptsRecord) {
  const DEVNET_SCRIPTS: Record<string, Pick<Script, 'codeHash' | 'hashType'> & { cellDeps: CellDepInfoLike[] }> = {
    [KnownScript.Secp256k1Blake160]: scripts.secp256k1_blake160_sighash_all!.script,
    [KnownScript.Secp256k1Multisig]: scripts.secp256k1_blake160_multisig_all!.script,
    [KnownScript.AnyoneCanPay]: scripts.anyone_can_pay!.script,
    [KnownScript.OmniLock]: scripts.omnilock!.script,
    [KnownScript.XUdt]: scripts.xudt!.script,
    [KnownScript.TypeId]: {
      codeHash: '0x00000000000000000000000000000000000000000000000000545950455f4944',
      hashType: 'type',
      cellDeps: [],
    },
    // ccc >= 1.14.0 calls getKnownScript(NervosDao) during completeFeeBy
    // for all inputs. Devnet deploys the DAO system cell, so map it to the
    // actual devnet script derived from list-hashes.
    [KnownScript.NervosDao]: scripts.dao!.script,
  };
  return DEVNET_SCRIPTS;
}

export function buildCCCDevnetKnownScripts() {
  const devnetSystemScripts = getDevnetSystemScriptsFromListHashes();
  if (devnetSystemScripts == null) {
    throw new Error('can not getSystemScriptsFromListHashes in devnet');
  }
  const devnetKnownScripts:
    | Record<
        KnownScript,
        Pick<ccc.Script, 'codeHash' | 'hashType'> & {
          cellDeps: ccc.CellDepInfoLike[];
        }
      >
    | undefined = toCCCKnownScripts(devnetSystemScripts);
  return devnetKnownScripts;
}

// Build the ccc client for the devnet. A forked devnet carries the source
// chain's genesis, so a mainnet fork must use the `ckb` address prefix
// (ClientPublicMainnet); everything else uses the `ckt` prefix. Known scripts
// always come from the fork-aware resolver above.
export function buildDevnetCCCClient(url: string, fallbacks: string[] = []) {
  const resolved = resolveDevnetSystemScripts();
  if (resolved == null) {
    throw new Error('can not getSystemScriptsFromListHashes in devnet');
  }
  const scripts = toCCCKnownScripts(resolved.scripts);
  const ClientCtor = resolved.forkedFrom === 'mainnet' ? ccc.ClientPublicMainnet : ccc.ClientPublicTestnet;
  return new ClientCtor({ url, scripts, fallbacks });
}
