import { readSettings } from '../cfg/setting';
import { getDevnetListHashes, ListHashes, SpecHashes, SystemCell } from '../util/list-hashes';
import toml from '@iarna/toml';
import { CellDepInfoLike, KnownScript, Script } from '@ckb-ccc/core';
import { ScriptInfo, SystemScript, SystemScriptName, SystemScriptsRecord } from '../scripts/type';
import { Network, NetworkOption } from '../type/base';
import { MAINNET_SYSTEM_SCRIPTS, TESTNET_SYSTEM_SCRIPTS } from '../scripts/public';

export enum PrintStyle {
  system = 'system',
  lumos = 'lumos',
  ccc = 'ccc',
}
export interface PrintProps extends NetworkOption {
  style?: PrintStyle;
}

export async function printSystemScripts({ style = PrintStyle.system, network = Network.devnet }: PrintProps) {
  const systemScripts =
    network === Network.mainnet
      ? MAINNET_SYSTEM_SCRIPTS
      : network === Network.testnet
        ? TESTNET_SYSTEM_SCRIPTS
        : getDevnetSystemScriptsFromListHashes();
  if (!systemScripts) return console.log(`SystemScripts is null, ${network}`);

  if (style === PrintStyle.system) {
    return printInSystemStyle(systemScripts, network);
  }

  if (style === PrintStyle.lumos) {
    return printInLumosConfigStyle(systemScripts, network);
  }

  if (style === PrintStyle.ccc) {
    return printInCCCStyle(systemScripts, network);
  }
}

export function printInSystemStyle(systemScripts: SystemScriptsRecord, network: Network) {
  console.log(`*** CKB ${network.toUpperCase()} System Scripts ***\n`);
  for (const [name, script] of Object.entries(systemScripts)) {
    console.log(`- name: ${name}`);
    if (script == null) {
      return console.log(`  undefined\n`);
    }
    console.log(`  file: ${script.file}`);
    console.log(`  code_hash: ${script.script.codeHash}`);
    console.log(`  hash_type: ${script.script.hashType}`);
    console.log(`  cellDeps: ${JSON.stringify(script.script.cellDeps, null, 2)}\n`);
  }
}

export function printInLumosConfigStyle(scripts: SystemScriptsRecord, network: Network) {
  const config = toLumosConfig(scripts, network === Network.mainnet ? 'ckb' : 'ckt');
  console.log(`*** CKB ${network.toUpperCase()} System Scripts As LumosConfig ***\n`);
  console.log(JSON.stringify(config, null, 2));
}

export function printInCCCStyle(scripts: SystemScriptsRecord, network: Network) {
  const knownsScripts = toCCCKnownScripts(scripts);
  console.log(`*** CKB ${network.toUpperCase()} System Scripts As CCC KnownScripts ***\n`);
  console.log(JSON.stringify(knownsScripts, null, 2));
}

export function getDevnetSystemScriptsFromListHashes(): SystemScriptsRecord | null {
  const settings = readSettings();
  const listHashesString = getDevnetListHashes(settings.bins.defaultCKBVersion);
  if (!listHashesString) {
    console.log(`list-hashes not found!`);
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
        depGroup.included_cells.includes(`Bundled(specs/cells/${name})`),
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

  return systemScripts;
}

export function systemCellToScriptInfo({
  cell,
  depType,
  depGroup,
  extraCellDeps,
}: {
  cell: SystemCell;
  depType: 'code' | 'depGroup';
  depGroup?: {
    txHash: string;
    index: number;
  };
  extraCellDeps?: ScriptInfo['cellDeps'];
}): ScriptInfo {
  // todo: we left the type in cellDepsInfo since it requires async fetching and
  // chain running to get the full type script of the type-id deps.
  // Also, in devnet there is no real need to auto upgrade the system scripts with type-id
  if (depType === 'code') {
    let cellDeps: ScriptInfo['cellDeps'] = [
      {
        cellDep: {
          outPoint: {
            txHash: cell.tx_hash as `0x${string}`,
            index: cell.index,
          },
          depType,
        },
      },
    ];
    if (extraCellDeps && extraCellDeps.length > 0) {
      cellDeps = [...extraCellDeps, ...cellDeps];
    }
    return {
      codeHash: (cell.type_hash || cell.data_hash) as `0x${string}`,
      hashType: cell.type_hash ? 'type' : 'data1',
      cellDeps,
    };
  }

  if (depType === 'depGroup') {
    if (!depGroup) {
      throw new Error('require depGroup info since the dep type is depGroup');
    }

    let cellDeps: ScriptInfo['cellDeps'] = [
      {
        cellDep: {
          outPoint: {
            txHash: depGroup!.txHash as `0x${string}`,
            index: depGroup!.index,
          },
          depType,
        },
      },
    ];
    if (extraCellDeps && extraCellDeps.length > 0) {
      cellDeps = [...extraCellDeps, ...cellDeps];
    }

    return {
      codeHash: (cell.type_hash || cell.data_hash) as `0x${string}`,
      hashType: cell.type_hash ? 'type' : 'data1',
      cellDeps,
    };
  }

  throw new Error(`unknown DepType ${depType}`);
}

export function toLumosConfig(scripts: SystemScriptsRecord, addressPrefix: 'ckb' | 'ckt' = 'ckt') {
  const config = {
    PREFIX: addressPrefix,
    SCRIPTS: {
      SECP256K1_BLAKE160: {
        CODE_HASH: scripts.secp256k1_blake160_sighash_all!.script.codeHash,
        HASH_TYPE: scripts.secp256k1_blake160_sighash_all!.script.hashType,
        TX_HASH: scripts.secp256k1_blake160_sighash_all!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.secp256k1_blake160_sighash_all!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.secp256k1_blake160_sighash_all!.script.cellDeps[0].cellDep.depType,
        SHORT_ID: 1,
      },
      SECP256K1_BLAKE160_MULTISIG: {
        CODE_HASH: scripts.secp256k1_blake160_multisig_all!.script.codeHash,
        HASH_TYPE: scripts.secp256k1_blake160_multisig_all!.script.hashType,
        TX_HASH: scripts.secp256k1_blake160_multisig_all!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.secp256k1_blake160_multisig_all!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.secp256k1_blake160_multisig_all!.script.cellDeps[0].cellDep.depType,
      },
      DAO: {
        CODE_HASH: scripts.dao!.script.codeHash,
        HASH_TYPE: scripts.dao!.script.hashType,
        TX_HASH: scripts.dao!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.dao!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.dao!.script.cellDeps[0].cellDep.depType,
        SHORT_ID: 2,
      },
      SUDT: {
        CODE_HASH: scripts.sudt!.script.codeHash,
        HASH_TYPE: scripts.sudt!.script.hashType,
        TX_HASH: scripts.sudt!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.sudt!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.sudt!.script.cellDeps[0].cellDep.depType,
      },
      XUDT: {
        CODE_HASH: scripts.xudt!.script.codeHash,
        HASH_TYPE: scripts.xudt!.script.hashType,
        TX_HASH: scripts.xudt!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.xudt!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.xudt!.script.cellDeps[0].cellDep.depType,
      },
      OMNILOCK: {
        CODE_HASH: scripts.omnilock!.script.codeHash,
        HASH_TYPE: scripts.omnilock!.script.hashType,
        TX_HASH: scripts.omnilock!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.omnilock!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.omnilock!.script.cellDeps[0].cellDep.depType,
      },
      ANYONE_CAN_PAY: {
        CODE_HASH: scripts.anyone_can_pay!.script.codeHash,
        HASH_TYPE: scripts.anyone_can_pay!.script.hashType,
        TX_HASH: scripts.anyone_can_pay!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.anyone_can_pay!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.anyone_can_pay!.script.cellDeps[0].cellDep.depType,
      },
      SPORE: {
        CODE_HASH: scripts.spore!.script.codeHash,
        HASH_TYPE: scripts.spore!.script.hashType,
        TX_HASH: scripts.spore!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.spore!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.spore!.script.cellDeps[0].cellDep.depType,
      },
      SPORE_CLUSTER: {
        CODE_HASH: scripts.spore_cluster!.script.codeHash,
        HASH_TYPE: scripts.spore_cluster!.script.hashType,
        TX_HASH: scripts.spore_cluster!.script.cellDeps[0].cellDep.outPoint.txHash,
        INDEX: '0x' + scripts.spore_cluster!.script.cellDeps[0].cellDep.outPoint.index.toString(16),
        DEP_TYPE: scripts.spore_cluster!.script.cellDeps[0].cellDep.depType,
      },
    },
  };
  if (scripts.always_success) {
    // @ts-expect-error we remove the lumos config type deps
    config.SCRIPTS['ALWAYS_SUCCESS'] = {
      CODE_HASH: scripts.always_success.script.codeHash,
      HASH_TYPE: scripts.always_success.script.hashType,
      TX_HASH: scripts.always_success.script.cellDeps[0].cellDep.outPoint.txHash,
      INDEX: '0x' + scripts.always_success.script.cellDeps[0].cellDep.outPoint.index.toString(16),
      DEP_TYPE: scripts.always_success.script.cellDeps[0].cellDep.depType,
    };
  }
  if (scripts.spore_cluster_agent) {
    // @ts-expect-error we remove the lumos config type deps
    config.SCRIPTS['SPORE_CLUSTER_AGENT'] = {
      CODE_HASH: scripts.spore_cluster_agent.script.codeHash,
      HASH_TYPE: scripts.spore_cluster_agent.script.hashType,
      TX_HASH: scripts.spore_cluster_agent.script.cellDeps[0].cellDep.outPoint.txHash,
      INDEX: '0x' + scripts.spore_cluster_agent.script.cellDeps[0].cellDep.outPoint.index.toString(16),
      DEP_TYPE: scripts.spore_cluster_agent.script.cellDeps[0].cellDep.depType,
    };
  }
  if (scripts.spore_cluster_proxy) {
    // @ts-expect-error we remove the lumos config type deps
    config.SCRIPTS['SPORE_CLUSTER_PROXY'] = {
      CODE_HASH: scripts.spore_cluster_proxy.script.codeHash,
      HASH_TYPE: scripts.spore_cluster_proxy.script.hashType,
      TX_HASH: scripts.spore_cluster_proxy.script.cellDeps[0].cellDep.outPoint.txHash,
      INDEX: '0x' + scripts.spore_cluster_proxy.script.cellDeps[0].cellDep.outPoint.index.toString(16),
      DEP_TYPE: scripts.spore_cluster_proxy.script.cellDeps[0].cellDep.depType,
    };
  }
  if (scripts.spore_extension_lua) {
    // @ts-expect-error we remove the lumos config type deps
    config.SCRIPTS['SPORE_LUA'] = {
      CODE_HASH: scripts.spore_extension_lua.script.codeHash,
      HASH_TYPE: scripts.spore_extension_lua.script.hashType,
      TX_HASH: scripts.spore_extension_lua.script.cellDeps[0].cellDep.outPoint.txHash,
      INDEX: '0x' + scripts.spore_extension_lua.script.cellDeps[0].cellDep.outPoint.index.toString(16),
      DEP_TYPE: scripts.spore_extension_lua.script.cellDeps[0].cellDep.depType,
    };
  }
  return config;
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
