import { CKB } from '../sdk/ckb';
import { NetworkOption, Network, UdtKind } from '../type/base';
import { logTxSuccess } from '../util/link';
import { validateNetworkOpt, validateUdtKind, validateUdtTypeArgs } from '../util/validator';

export interface UdtIssueOption extends NetworkOption {
  udtKind: UdtKind;
  typeArgs?: string;
  to?: string;
  privkey: string;
}

export interface UdtDestroyOption extends NetworkOption {
  udtKind: UdtKind;
  typeArgs: string;
  privkey: string;
}

export async function udtIssue(
  amount: string,
  opt: UdtIssueOption = { network: Network.devnet, udtKind: 'sudt', privkey: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);
  validateUdtKind(opt.udtKind);

  if (!opt.privkey) {
    throw new Error('--privkey is required!');
  }

  const ckb = new CKB({ network });
  const txHash = await ckb.udtIssue({
    privateKey: opt.privkey,
    kind: opt.udtKind,
    amount,
    typeArgs: opt.typeArgs ? validateUdtTypeArgs(opt.udtKind, opt.typeArgs) : undefined,
    toAddress: opt.to,
  });

  logTxSuccess(network, txHash, 'issued UDT');
}

export async function udtDestroy(
  amount: string,
  opt: UdtDestroyOption = { network: Network.devnet, udtKind: 'sudt', typeArgs: '', privkey: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);
  validateUdtKind(opt.udtKind);

  if (!opt.privkey) {
    throw new Error('--privkey is required!');
  }

  const ckb = new CKB({ network });
  const txHash = await ckb.udtDestroy({
    privateKey: opt.privkey,
    kind: opt.udtKind,
    amount,
    typeArgs: validateUdtTypeArgs(opt.udtKind, opt.typeArgs),
  });

  logTxSuccess(network, txHash, 'destroyed UDT');
}
