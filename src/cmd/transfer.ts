import { CKB } from '../sdk/ckb';
import { NetworkOption, Network, UdtKind } from '../type/base';
import { logTxSuccess } from '../util/link';
import { validateNetworkOpt, validateUdtAmount, validateUdtKind, validateUdtTypeArgs } from '../util/validator';
import { resolvePrivateKey } from '../util/private-key';
import { logger } from '../util/logger';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';
import { validateMainnetForkSigning } from '../util/fork-safety';

export interface TransferOptions extends NetworkOption {
  privkey?: string | null;
  privkeyFile?: string | null;
  udtKind?: UdtKind;
  udtTypeArgs?: string;
  allowExternalKeyOnMainnetFork?: boolean;
}

export async function transfer(toAddress: string, amount: string, opt: TransferOptions = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  let udtKind: UdtKind | undefined;
  let udtTypeArgs: string | undefined;
  if (opt.udtKind != null || opt.udtTypeArgs != null) {
    if (!opt.udtTypeArgs) {
      throw new Error('UDT type args are required for a UDT transfer');
    }
    validateUdtAmount(amount);
    udtKind = opt.udtKind ?? 'sudt';
    validateUdtKind(udtKind);
    udtTypeArgs = validateUdtTypeArgs(udtKind, opt.udtTypeArgs);
  }

  const privateKey = resolvePrivateKey(opt);
  const rejectInputsAtOrBeforeBlock = validateMainnetForkSigning(
    network,
    privateKey,
    opt.allowExternalKeyOnMainnetFork,
  );
  await warnIfForkIndexerIsBehind(network);
  const ckb = new CKB({ network });

  if (udtKind && udtTypeArgs) {
    const udtType = await ckb.buildUdtTypeScript(udtKind, udtTypeArgs);
    const txHash = await ckb.udtTransfer({
      toAddress,
      amount,
      privateKey,
      udtType,
      kind: udtKind,
      rejectInputsAtOrBeforeBlock,
    });

    logTxSuccess(network, txHash, 'transfer UDT');
    logger.result({
      command: 'udt.transfer',
      network,
      kind: udtKind,
      amount,
      typeArgs: udtTypeArgs,
      toAddress,
      txHash,
    });
    return txHash;
  }

  const txHash = await ckb.transfer({
    toAddress,
    amountInCKB: amount,
    privateKey,
    rejectInputsAtOrBeforeBlock,
  });
  logTxSuccess(network, txHash, 'transfer');
  logger.result({ command: 'transfer', network, amount, toAddress, txHash });
  return txHash;
}
