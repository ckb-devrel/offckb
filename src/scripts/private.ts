import { ccc, CellDepInfoLike, KnownScript, Script } from '@ckb-ccc/core';
import { readSettings } from '../cfg/setting';
import { systemCellToScriptInfo } from '../cmd/system-scripts';
import { getDevnetListHashes, ListHashes, SpecHashes } from '../util/list-hashes';
import { logger } from '../util/logger';
import { TYPE_ID_SCRIPT } from './const';
import { SystemScriptsRecord, SystemScriptName, SystemScript } from './type';
import toml from '@iarna/toml';

export function getDevnetSystemScriptsFromListHashes(): SystemScriptsRecord | null {
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
  const systemScriptArray = chainSpecHashes.system_cells
    .map((cell) => {
      // Extract the file name
      const name = cell.path.split('/').pop()?.replace(')', '') || 'unknown script';
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
