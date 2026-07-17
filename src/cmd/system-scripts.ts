import { SystemScriptsRecord } from '../scripts/type';
import { Network, NetworkOption } from '../type/base';
import { MAINNET_SYSTEM_SCRIPTS, TESTNET_SYSTEM_SCRIPTS } from '../scripts/public';
import { logger } from '../util/logger';
import { resolveDevnetSystemScripts, toCCCKnownScripts } from '../scripts/private';

export enum PrintStyle {
  system = 'system',
  lumos = 'lumos',
  ccc = 'ccc',
}
export interface PrintProps extends NetworkOption {
  style?: PrintStyle;
}

export async function printSystemScripts({ style = PrintStyle.system, network = Network.devnet }: PrintProps) {
  let systemScripts: SystemScriptsRecord | null;
  // Display label and address prefix follow the chain the devnet actually
  // runs: a fork carries the source chain's genesis, scripts and prefix.
  let label = network.toUpperCase();
  let addressPrefix: 'ckb' | 'ckt' = network === Network.mainnet ? 'ckb' : 'ckt';
  if (network === Network.mainnet) {
    systemScripts = MAINNET_SYSTEM_SCRIPTS;
  } else if (network === Network.testnet) {
    systemScripts = TESTNET_SYSTEM_SCRIPTS;
  } else {
    const resolved = resolveDevnetSystemScripts();
    systemScripts = resolved?.scripts ?? null;
    if (resolved?.forkedFrom) {
      label = `DEVNET (fork of ${resolved.forkedFrom.toUpperCase()})`;
      addressPrefix = resolved.forkedFrom === 'mainnet' ? 'ckb' : 'ckt';
    }
  }

  if (!systemScripts) return logger.info(`SystemScripts is null, ${network}`);

  if (style === PrintStyle.system) {
    return printInSystemStyle(systemScripts, label);
  }

  if (style === PrintStyle.lumos) {
    return printInLumosConfigStyle(systemScripts, label, addressPrefix);
  }

  if (style === PrintStyle.ccc) {
    return printInCCCStyle(systemScripts, label);
  }
}

export function printInSystemStyle(systemScripts: SystemScriptsRecord, label: string) {
  logger.info(`*** CKB ${label} System Scripts ***\n`);
  for (const [name, script] of Object.entries(systemScripts)) {
    logger.info(`- name: ${name}`);
    if (script == null) {
      logger.info(`  undefined\n`);
      continue;
    }
    logger.info(`  file: ${script.file}`);
    logger.info(`  code_hash: ${script.script.codeHash}`);
    logger.info(`  hash_type: ${script.script.hashType}`);
    logger.info(`  cellDeps: ${JSON.stringify(script.script.cellDeps, null, 2)}\n`);
  }
}

export function printInLumosConfigStyle(scripts: SystemScriptsRecord, label: string, addressPrefix: 'ckb' | 'ckt') {
  const config = toLumosConfig(scripts, addressPrefix);
  logger.info(`*** CKB ${label} System Scripts As LumosConfig ***\n`);
  logger.info(JSON.stringify(config, null, 2));
}

export function printInCCCStyle(scripts: SystemScriptsRecord, label: string) {
  const knownsScripts = toCCCKnownScripts(scripts);
  logger.info(`*** CKB ${label} System Scripts As CCC KnownScripts ***\n`);
  logger.info(JSON.stringify(knownsScripts, null, 2));
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
