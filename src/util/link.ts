import { logger } from './logger';
import { Network } from '../type/base';

export function buildTestnetTxLink(txHash: string) {
  return `https://pudge.explorer.nervos.org/transaction/${txHash}`;
}

export function logTxSuccess(network: Network, txHash: string, action: string) {
  if (network === 'testnet') {
    logger.info(`Successfully ${action}, check ${buildTestnetTxLink(txHash)} for details.`);
  } else {
    logger.info(`Successfully ${action}, txHash:`, txHash);
  }
}
