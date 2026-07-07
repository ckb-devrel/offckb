import { CKB, UdtKind } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';
import { logger } from '../util/logger';

export interface UdtBalanceOption extends NetworkOption {
  kind: UdtKind;
  typeArgs: string;
}

export interface UdtTransferOption extends NetworkOption {
  kind: UdtKind;
  typeArgs: string;
  privkey: string;
}

export async function udtBalance(address: string, opt: UdtBalanceOption = { network: Network.devnet, kind: 'sudt', typeArgs: '' }) {
  const network = opt.network;
  validateNetworkOpt(network);

  const ckb = new CKB({ network });
  const udtType = await ckb.buildUdtTypeScript(opt.kind, opt.typeArgs);
  const balance = await ckb.udtBalance(address, udtType);
  logger.info(`UDT Balance: ${balance}`);
  process.exit(0);
}

export async function udtTransfer(
  toAddress: string,
  amount: string,
  opt: UdtTransferOption = { network: Network.devnet, kind: 'sudt', typeArgs: '', privkey: '' },
) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (!opt.privkey) {
    throw new Error('--privkey is required!');
  }

  const ckb = new CKB({ network });
  const udtType = await ckb.buildUdtTypeScript(opt.kind, opt.typeArgs);
  const txHash = await ckb.udtTransfer({
    toAddress,
    amount,
    privateKey: opt.privkey,
    udtType,
  });

  if (network === 'testnet') {
    logger.info(`Successfully transfer UDT, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }

  logger.info('Successfully transfer UDT, txHash:', txHash);
}
