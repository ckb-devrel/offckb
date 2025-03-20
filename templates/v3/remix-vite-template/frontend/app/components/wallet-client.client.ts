import { ccc, CellDepInfoLike, KnownScript, Script } from '@ckb-ccc/connector-react';
import offCKBConfig, { Network } from 'offckb.config';

export const DEVNET_SCRIPTS: Record<string, Pick<Script, 'codeHash' | 'hashType'> & { cellDeps: CellDepInfoLike[] }> = {
  [KnownScript.Secp256k1Blake160]: offCKBConfig.systemScripts.secp256k1_blake160_sighash_all!.script,
  [KnownScript.Secp256k1Multisig]: offCKBConfig.systemScripts.secp256k1_blake160_multisig_all!.script,
  [KnownScript.AnyoneCanPay]: offCKBConfig.systemScripts.anyone_can_pay!.script,
  [KnownScript.OmniLock]: offCKBConfig.systemScripts.omnilock!.script,
  [KnownScript.XUdt]: offCKBConfig.systemScripts.xudt!.script,
};

export function buildCccClient(network: Network) {
  const client =
    network === 'mainnet'
      ? new ccc.ClientPublicMainnet()
      : network === 'testnet'
        ? new ccc.ClientPublicTestnet()
        : new ccc.ClientPublicTestnet({ url: offCKBConfig.rpcUrl, scripts: DEVNET_SCRIPTS });

  return client;
}
