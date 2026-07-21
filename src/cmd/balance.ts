import { CKB, UdtBalanceInfo } from '../sdk/ckb';
import { validateNetworkOpt } from '../util/validator';
import { NetworkOption, Network, UdtKind } from '../type/base';
import { logger } from '../util/logger';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';

export interface BalanceOption extends NetworkOption {
  udtKind?: UdtKind;
  udtTypeArgs?: string;
  udt?: boolean;
}

export async function balanceOf(address: string, opt: BalanceOption = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  await warnIfForkIndexerIsBehind(network);

  const ckb = new CKB({ network });

  const [balanceInCKB, udtBalances] = await Promise.all([
    ckb.balance(address),
    opt.udt !== false ? ckb.detectUdtBalances(address) : Promise.resolve([]),
  ]);
  logger.info(`CKB: ${balanceInCKB}`);

  const filtered = filterUdtBalances(udtBalances, opt);

  if (filtered.length > 0) {
    logger.info('UDT:');
    for (const udt of filtered) {
      logger.info(`  ${udt.kind} (args=${udt.args}): ${udt.balance}`);
    }
  }
  const result = { command: 'balance', network, address, ckb: balanceInCKB, udt: filtered };
  logger.result(result);
  return result;
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
