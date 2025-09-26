import { CKB } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';
import { logger } from '../util/logger';

export interface TransferOptions extends NetworkOption {
  privkey?: string | null;
}

export async function transfer(
  toAddress: string,
  amountInCKB: string,
  opt: TransferOptions = { network: Network.devnet },
) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (opt.privkey == null) {
    throw new Error('--privkey is required!');
  }

  const privateKey = opt.privkey;
  const ckb = new CKB({ network });

  const txHash = await ckb.transfer({
    toAddress,
    amountInCKB,
    privateKey,
  });
  if (network === 'testnet') {
    logger.info(`Successfully transfer, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }

  logger.info('Successfully transfer, txHash:', txHash);
}
