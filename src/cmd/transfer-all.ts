import { CKB } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';
import { logger } from '../util/logger';
import { resolvePrivateKey } from '../util/private-key';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';
import { validateMainnetForkSigning } from '../util/fork-safety';

export interface TransferAllOptions extends NetworkOption {
  privkey?: string | null;
  privkeyFile?: string | null;
  allowExternalKeyOnMainnetFork?: boolean;
}

export async function transferAll(toAddress: string, opt: TransferAllOptions = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  const privateKey = resolvePrivateKey(opt);
  // transfer-all sweeps the whole balance, which makes it the most likely
  // command to pick up copied pre-fork Mainnet cells — enforce, not just warn.
  const rejectInputsAtOrBeforeBlock = validateMainnetForkSigning(
    network,
    privateKey,
    opt.allowExternalKeyOnMainnetFork,
  );
  await warnIfForkIndexerIsBehind(network);
  const ckb = new CKB({ network });

  const txHash = await ckb.transferAll({
    toAddress,
    privateKey,
    rejectInputsAtOrBeforeBlock,
  });
  if (network === 'testnet') {
    logger.info(`Successfully transfer, check ${buildTestnetTxLink(txHash)} for details.`);
    logger.result({ command: 'transfer-all', network, toAddress, txHash });
    return txHash;
  }

  logger.info('Successfully transfer, txHash:', txHash);
  logger.result({ command: 'transfer-all', network, toAddress, txHash });
  return txHash;
}
