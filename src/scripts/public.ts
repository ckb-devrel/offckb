import { ScriptInfo, SystemScriptsRecord } from './type';
import { TESTNET_SCRIPTS } from '@ckb-ccc/core/advanced';
import { MAINNET_SCRIPTS } from '@ckb-ccc/core/advanced';
import { TYPE_ID_SCRIPT } from './const';

// spore: https://github.com/sporeprotocol/spore-contract/blob/master/docs/VERSIONS.md

export const TESTNET_SYSTEM_SCRIPTS: SystemScriptsRecord = {
  secp256k1_blake160_sighash_all: {
    name: 'secp256k1_blake160_sighash_all',
    script: TESTNET_SCRIPTS.Secp256k1Blake160 as unknown as ScriptInfo,
  },
  dao: {
    name: 'dao',
    script: TESTNET_SCRIPTS.NervosDao as unknown as ScriptInfo,
  },
  secp256k1_blake160_multisig_all: {
    name: 'secp256k1_blake160_multisig_all',
    script: TESTNET_SCRIPTS.Secp256k1Multisig as unknown as ScriptInfo,
  },
  sudt: {
    name: 'sudt',
    script: {
      codeHash: '0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xe12877ebd2c3c364dc46c5c992bcfaf4fee33fa13eebdf82c591fc9825aab769',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  xudt: {
    name: 'xudt',
    script: TESTNET_SCRIPTS.XUdt as unknown as ScriptInfo,
  },
  omnilock: {
    name: 'omnilock',
    script: TESTNET_SCRIPTS.OmniLock as unknown as ScriptInfo,
  },
  anyone_can_pay: {
    name: 'anyone_can_pay',
    script: TESTNET_SCRIPTS.AnyoneCanPay as unknown as ScriptInfo,
  },
  always_success: undefined,
  spore: {
    name: 'spore',
    script: {
      codeHash: '0x685a60219309029d01310311dba953d67029170ca4848a4ff638e57002130a0d',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x5e8d2a517d50fd4bb4d01737a7952a1f1d35c8afc77240695bb569cd7d9d5a1f',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_cluster: {
    name: 'spore_cluster',
    script: {
      codeHash: '0x0bbe768b519d8ea7b96d58f1182eb7e6ef96c541fbd9526975077ee09f049058',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xcebb174d6e300e26074aea2f5dbd7f694bb4fe3de52b6dfe205e54f90164510a',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_cluster_agent: {
    name: 'spore_cluster_agent',
    script: {
      codeHash: '0x923e997654b2697ee3f77052cb884e98f28799a4270fd412c3edb8f3987ca622',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x52210232292d10c51b48e72a2cea60d8f0a08c2680a97a8ee7ca0a39379f0036',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_cluster_proxy: {
    name: 'spore_cluster_proxy',
    script: {
      codeHash: '0x4349889bda064adab8f49f7dd8810d217917f7df28e9b2a1df0b74442399670a',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xc5a41d58155b11ecd87a5a49fdcb6e83bd6684d3b72b2f3686f081945461c156',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_extension_lua: {
    name: 'spore_extension_lua',
    script: {
      codeHash: '0x5ff1a403458b436ea4b2ceb72f1fa70a6507968493315b646f5302661cb68e57',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x9b2098e5b6f575b2fd34ffd0212bc1c96e1f9e86fcdb146511849c174dfe0d02',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  ckb_js_vm: {
    name: 'ckb_js_vm',
    script: {
      codeHash: '0x3e9b6bead927bef62fcb56f0c79f4fbd1b739f32dd222beac10d346f2918bed7',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x9f6558e91efa7580bfe97830d11cd94ca5d614bbf4a10b36f3a5b9d092749353',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  nostr_lock: {
    name: 'nostr_lock',
    script: {
      codeHash: '0x6ae5ee0cb887b2df5a9a18137315b9bdc55be8d52637b2de0624092d5f0c91d5',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xa2a434dcdbe280b9ed75bb7d6c7d68186a842456aba0fc506657dc5ed7c01d68',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  type_id: TYPE_ID_SCRIPT,
  secp256k1_keccak256_sighash_all: undefined,
  secp256k1_keccak256_sighash_all_acpl: undefined,
  secp256k1_blake160_multisig_all_v2: undefined,
};

export const MAINNET_SYSTEM_SCRIPTS: SystemScriptsRecord = {
  secp256k1_blake160_sighash_all: {
    name: 'secp256k1_blake160_sighash_all',
    script: MAINNET_SCRIPTS.Secp256k1Blake160 as unknown as ScriptInfo,
  },
  dao: {
    name: 'dao',
    script: MAINNET_SCRIPTS.NervosDao as unknown as ScriptInfo,
  },
  secp256k1_blake160_multisig_all: {
    name: 'secp256k1_blake160_multisig_all',
    script: MAINNET_SCRIPTS.Secp256k1Multisig as unknown as ScriptInfo,
  },
  sudt: {
    name: 'sudt',
    script: {
      codeHash: '0x5e7a36a77e68eecc013dfa2fe6a23f3b6c344b04005808694ae6dd45eea4cfd5',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xc7813f6a415144643970c2e88e0bb6ca6a8edc5dd7c1022746f628284a9936d5',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  xudt: {
    name: 'xudt',
    script: MAINNET_SCRIPTS.XUdt as unknown as ScriptInfo,
  },
  omnilock: {
    name: 'omnilock',
    script: MAINNET_SCRIPTS.OmniLock as unknown as ScriptInfo,
  },
  anyone_can_pay: {
    name: 'anyone_can_pay',
    script: MAINNET_SCRIPTS.AnyoneCanPay as unknown as ScriptInfo,
  },
  always_success: undefined,
  spore: {
    name: 'spore',
    script: {
      codeHash: '0x4a4dce1df3dffff7f8b2cd7dff7303df3b6150c9788cb75dcf6747247132b9f5',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x96b198fb5ddbd1eed57ed667068f1f1e55d07907b4c0dbd38675a69ea1b69824',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_cluster: {
    name: 'spore_cluster',
    script: {
      codeHash: '0x7366a61534fa7c7e6225ecc0d828ea3b5366adec2b58206f2ee84995fe030075',
      hashType: 'data',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xe464b7fb9311c5e2820e61c99afc615d6b98bdefbe318c34868c010cbd0dc938',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  spore_cluster_agent: undefined,
  spore_cluster_proxy: undefined,
  spore_extension_lua: undefined,
  ckb_js_vm: undefined,
  nostr_lock: {
    name: 'nostr_lock',
    script: {
      codeHash: '0x641a89ad2f77721b803cd50d01351c1f308444072d5fa20088567196c0574c68',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x1911208b136957d5f7c1708a8835edfe8ae1d02700d5cb2c3a6aacf4d5906306',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  type_id: TYPE_ID_SCRIPT,
  secp256k1_keccak256_sighash_all: undefined,
  secp256k1_keccak256_sighash_all_acpl: undefined,
  secp256k1_blake160_multisig_all_v2: undefined,
};

export default {
  testnet: TESTNET_SYSTEM_SCRIPTS,
  mainnet: MAINNET_SYSTEM_SCRIPTS,
};
