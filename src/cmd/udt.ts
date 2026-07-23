import { CKB } from '../sdk/ckb';
import { NetworkOption, Network, UdtKind } from '../type/base';
import { logTxSuccess } from '../util/link';
import { validateNetworkOpt, validateUdtAmount, validateUdtKind, validateUdtTypeArgs } from '../util/validator';
import { resolvePrivateKey } from '../util/private-key';
import { logger } from '../util/logger';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';
import { validateMainnetForkSigning } from '../util/fork-safety';

export interface UdtIssueOption extends NetworkOption {
  udtKind: UdtKind;
  typeArgs?: string;
  to?: string;
  privkey?: string;
  privkeyFile?: string;
  allowExternalKeyOnMainnetFork?: boolean;
}

export interface UdtDestroyOption extends NetworkOption {
  udtKind: UdtKind;
  typeArgs: string;
  privkey?: string;
  privkeyFile?: string;
  allowExternalKeyOnMainnetFork?: boolean;
}

export async function udtIssue(amount: string, opt: UdtIssueOption = { network: Network.devnet, udtKind: 'sudt' }) {
  const network = opt.network;
  validateNetworkOpt(network);
  validateUdtKind(opt.udtKind);
  validateUdtAmount(amount);
  const typeArgs = opt.typeArgs ? validateUdtTypeArgs(opt.udtKind, opt.typeArgs) : undefined;

  const privateKey = resolvePrivateKey(opt);
  const rejectInputsAtOrBeforeBlock = validateMainnetForkSigning(
    network,
    privateKey,
    opt.allowExternalKeyOnMainnetFork,
  );
  await warnIfForkIndexerIsBehind(network);

  const ckb = new CKB({ network });
  const result = await ckb.udtIssue({
    privateKey,
    kind: opt.udtKind,
    amount,
    typeArgs,
    toAddress: opt.to,
    rejectInputsAtOrBeforeBlock,
  });

  logTxSuccess(network, result.txHash, 'issued UDT');
  logger.info(`UDT kind: ${opt.udtKind}`);
  logger.info(`UDT type args: ${result.typeArgs}`);
  logger.info(`Receiver: ${result.receiver}`);
  logger.info(`Next: offckb balance ${result.receiver} --udt-kind ${opt.udtKind} --udt-type-args ${result.typeArgs}`);
  logger.result({
    command: 'udt.issue',
    network,
    kind: opt.udtKind,
    amount,
    receiver: result.receiver,
    typeArgs: result.typeArgs,
    txHash: result.txHash,
  });
  return result;
}

export async function udtDestroy(
  amount: string,
  opt: UdtDestroyOption = { network: Network.devnet, udtKind: 'sudt', typeArgs: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);
  validateUdtKind(opt.udtKind);
  validateUdtAmount(amount);
  const typeArgs = validateUdtTypeArgs(opt.udtKind, opt.typeArgs);

  const privateKey = resolvePrivateKey(opt);
  const rejectInputsAtOrBeforeBlock = validateMainnetForkSigning(
    network,
    privateKey,
    opt.allowExternalKeyOnMainnetFork,
  );
  await warnIfForkIndexerIsBehind(network);

  const ckb = new CKB({ network });
  const txHash = await ckb.udtDestroy({
    privateKey,
    kind: opt.udtKind,
    amount,
    typeArgs,
    rejectInputsAtOrBeforeBlock,
  });

  logTxSuccess(network, txHash, 'destroyed UDT');
  logger.result({ command: 'udt.destroy', network, kind: opt.udtKind, amount, typeArgs, txHash });
  return txHash;
}
