import { CKB, UdtKind } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';
import { logger } from '../util/logger';

export interface UdtIssueOption extends NetworkOption {
  kind: UdtKind;
  typeArgs?: string;
  to?: string;
  privkey: string;
}

export interface UdtDestroyOption extends NetworkOption {
  kind: UdtKind;
  typeArgs: string;
  privkey: string;
}

export async function udtIssue(
  amount: string,
  opt: UdtIssueOption = { network: Network.devnet, kind: 'sudt', privkey: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (!opt.privkey) {
    throw new Error('--privkey is required!');
  }

  const ckb = new CKB({ network });
  const txHash = await ckb.udtIssue({
    privateKey: opt.privkey,
    kind: opt.kind,
    amount,
    typeArgs: opt.typeArgs,
    toAddress: opt.to,
  });

  if (network === 'testnet') {
    logger.info(`Successfully issued UDT, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }
  logger.info('Successfully issued UDT, txHash:', txHash);
}

export async function udtDestroy(
  amount: string,
  opt: UdtDestroyOption = { network: Network.devnet, kind: 'sudt', typeArgs: '', privkey: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (!opt.privkey) {
    throw new Error('--privkey is required!');
  }

  const ckb = new CKB({ network });
  const txHash = await ckb.udtDestroy({
    privateKey: opt.privkey,
    kind: opt.kind,
    amount,
    typeArgs: opt.typeArgs,
  });

  if (network === 'testnet') {
    logger.info(`Successfully destroyed UDT, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }
  logger.info('Successfully destroyed UDT, txHash:', txHash);
}
