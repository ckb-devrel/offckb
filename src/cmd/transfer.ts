import { CKB } from '../sdk/ckb';
import { NetworkOption, Network, UdtKind } from '../type/base';
import { logTxSuccess } from '../util/link';
import { validateNetworkOpt, validateUdtKind, validateUdtTypeArgs } from '../util/validator';

export interface TransferOptions extends NetworkOption {
  privkey?: string | null;
  udtKind?: UdtKind;
  udtTypeArgs?: string;
}

export async function transfer(toAddress: string, amount: string, opt: TransferOptions = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (opt.privkey == null) {
    throw new Error('--privkey is required!');
  }

  const privateKey = opt.privkey;
  const ckb = new CKB({ network });

  if (opt.udtTypeArgs) {
    const kind = opt.udtKind ?? 'sudt';
    validateUdtKind(kind);
    const udtTypeArgs = validateUdtTypeArgs(kind, opt.udtTypeArgs);
    const udtType = await ckb.buildUdtTypeScript(kind, udtTypeArgs);
    const txHash = await ckb.udtTransfer({
      toAddress,
      amount,
      privateKey,
      udtType,
      kind,
    });

    logTxSuccess(network, txHash, 'transfer UDT');
    return;
  }

  const txHash = await ckb.transfer({
    toAddress,
    amountInCKB: amount,
    privateKey,
  });
  logTxSuccess(network, txHash, 'transfer');
}
