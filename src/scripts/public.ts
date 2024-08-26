import { SystemScriptsRecord } from './type';

// spore: https://github.com/sporeprotocol/spore-contract/blob/master/docs/VERSIONS.md

export const TESTNET_SYSTEM_SCRIPTS: SystemScriptsRecord = {
  secp256k1_blake160_sighash_all: {
    name: 'secp256k1_blake160_sighash_all',
    script: {
      codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
              index: 0,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
  },
  dao: {
    name: 'dao',
    script: {
      codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x8f8c79eb6671709633fe6a46de93c0fedc9c1b8a6527a18d3983879542635c9f',
              index: 2,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  secp256k1_blake160_multisig_all: {
    name: 'secp256k1_blake160_multisig_all',
    file: 'Bundled(specs/cells/secp256k1_blake160_multisig_all)',
    script: {
      codeHash: '0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
              index: 1,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
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
    script: {
      codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  omnilock: {
    name: 'omnilock',
    script: {
      codeHash: '0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  anyone_can_pay: {
    name: 'anyone_can_pay',
    script: {
      codeHash: '0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xec26b0f85ed839ece5f11c4c4e837ec359f5adc4420410f6453b1f6b60fb96a6',
              index: 0,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
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
};

export const MAINNET_SYSTEM_SCRIPTS: SystemScriptsRecord = {
  secp256k1_blake160_sighash_all: {
    name: 'secp256k1_blake160_sighash_all',
    script: {
      codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c',
              index: 0,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
  },
  dao: {
    name: 'dao',
    script: {
      codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xe2fb199810d49a4d8beec56718ba2593b665db9d52299a0f9e6e75416d73ff5c',
              index: 2,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  secp256k1_blake160_multisig_all: {
    name: 'secp256k1_blake160_multisig_all',
    script: {
      codeHash: '0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c',
              index: 1,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
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
    script: {
      codeHash: '0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95',
      hashType: 'data1',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xc07844ce21b38e4b071dd0e1ee3b0e27afd8d7532491327f39b786343f558ab7',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  omnilock: {
    name: 'omnilock',
    script: {
      codeHash: '0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0xc76edf469816aa22f416503c38d0b533d2a018e253e379f134c3985b3472c842',
              index: 0,
            },
            depType: 'code',
          },
        },
      ],
    },
  },
  anyone_can_pay: {
    name: 'anyone_can_pay',
    script: {
      codeHash: '0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354',
      hashType: 'type',
      cellDeps: [
        {
          cellDep: {
            outPoint: {
              txHash: '0x4153a2014952d7cac45f285ce9a7c5c0c0e1b21f2d378b82ac1433cb11c25c4d',
              index: 0,
            },
            depType: 'depGroup',
          },
        },
      ],
    },
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
};

export default {
  testnet: TESTNET_SYSTEM_SCRIPTS,
  mainnet: MAINNET_SYSTEM_SCRIPTS,
};