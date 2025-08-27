import { CKB } from '../sdk/ckb';
import { validateNetworkOpt } from '../util/validator';
import { NetworkOption, Network } from '../type/base';
import { logger } from '../util/logger';

export interface BalanceOption extends NetworkOption {}

export async function balanceOf(address: string, opt: BalanceOption = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  const ckb = new CKB({ network });

  const balanceInCKB = await ckb.balance(address);
  logger.info(`Balance: ${balanceInCKB} CKB`);
  process.exit(0);
}
