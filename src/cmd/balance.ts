import { CKB, UdtBalanceInfo, UdtKind } from '../sdk/ckb';
import { validateNetworkOpt } from '../util/validator';
import { NetworkOption, Network } from '../type/base';
import { logger } from '../util/logger';

export interface BalanceOption extends NetworkOption {
  udtKind?: UdtKind;
  udtTypeArgs?: string;
}

export async function balanceOf(address: string, opt: BalanceOption = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  const ckb = new CKB({ network });

  const balanceInCKB = await ckb.balance(address);
  logger.info(`CKB: ${balanceInCKB}`);

  const udtBalances = await ckb.detectUdtBalances(address);
  const filtered = filterUdtBalances(udtBalances, opt);

  if (filtered.length > 0) {
    logger.info('UDT:');
    for (const udt of filtered) {
      logger.info(`  ${udt.kind} (args=${udt.args}): ${udt.balance}`);
    }
  }
}

function filterUdtBalances(balances: UdtBalanceInfo[], opt: BalanceOption): UdtBalanceInfo[] {
  if (!opt.udtKind && !opt.udtTypeArgs) {
    return balances;
  }

  return balances.filter((udt) => {
    const kindMatch = opt.udtKind ? udt.kind === opt.udtKind : true;
    const argsMatch = opt.udtTypeArgs ? udt.args === opt.udtTypeArgs : true;
    return kindMatch && argsMatch;
  });
}
