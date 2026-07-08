import { CKB, UdtKind } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt, validateUdtKind, validateUdtTypeArgs } from '../util/validator';
import { logger } from '../util/logger';

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
    });

    if (network === 'testnet') {
      logger.info(`Successfully transfer UDT, check ${buildTestnetTxLink(txHash)} for details.`);
      return;
    }
    logger.info('Successfully transfer UDT, txHash:', txHash);
    return;
  }

  const txHash = await ckb.transfer({
    toAddress,
    amountInCKB: amount,
    privateKey,
  });
  if (network === 'testnet') {
    logger.info(`Successfully transfer, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }

  logger.info('Successfully transfer, txHash:', txHash);
}
