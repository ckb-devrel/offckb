import { SystemScript } from './type';

export const TYPE_ID_SCRIPT: SystemScript = {
  name: 'type_id',
  script: {
    codeHash: '0x00000000000000000000000000000000000000000000000000545950455f4944',
    hashType: 'type',
    cellDeps: [],
  },
};

// Well-known genesis block hashes, used to identify which chain a devnet
// actually runs (a forked devnet carries the source chain's genesis).
// https://github.com/nervosnetwork/ckb/tree/master/resource/specs
export const MAINNET_GENESIS_HASH = '0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5';
export const TESTNET_GENESIS_HASH = '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606';

export type PublicChainIdentity = 'mainnet' | 'testnet';

export function identifyPublicChainByGenesisHash(genesisHash: string | undefined | null): PublicChainIdentity | null {
  if (genesisHash === MAINNET_GENESIS_HASH) return 'mainnet';
  if (genesisHash === TESTNET_GENESIS_HASH) return 'testnet';
  return null;
}
