import { DepType, HashType } from '@ckb-ccc/core';

export enum SystemScriptName {
  secp256k1_blake160_sighash_all = 'secp256k1_blake160_sighash_all',
  secp256k1_blake160_multisig_all = 'secp256k1_blake160_multisig_all',
  dao = 'dao',
  sudt = 'sudt',
  xudt = 'xudt',
  omnilock = 'omnilock',
  anyone_can_pay = 'anyone_can_pay',
  always_success = 'always_success',
  spore = 'spore',
  spore_cluster = 'spore_cluster',
  spore_cluster_agent = 'spore_cluster_agent',
  spore_cluster_proxy = 'spore_cluster_proxy',
  spore_extension_lua = 'spore_extension_lua',
  ckb_js_vm = 'ckb_js_vm',
  nostr_lock = 'nostr_lock',
}

export interface ScriptInfo {
  codeHash: `0x${string}`;
  hashType: HashType;
  cellDeps: {
    cellDep: {
      outPoint: {
        txHash: `0x${string}`;
        index: number;
      };
      depType: DepType;
    };
    type?: {
      codeHash: `0x${string}`;
      hashType: HashType;
      args: `0x${string}`;
    };
  }[];
}

export interface SystemScript {
  name: string;
  file?: string;
  script: ScriptInfo;
}

export type SystemScriptsRecord = Record<SystemScriptName, SystemScript | undefined>;

export interface NetworkSystemScripts {
  devnet: SystemScriptsRecord;
  testnet: SystemScriptsRecord;
  mainnet: SystemScriptsRecord;
}

export type MyScriptsRecord = Record<string, ScriptInfo | undefined>;

export interface NetworkMyScripts {
  devnet: MyScriptsRecord;
  testnet: MyScriptsRecord;
  mainnet: MyScriptsRecord;
}
