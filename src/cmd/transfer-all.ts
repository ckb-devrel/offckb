import { CKB } from '../sdk/ckb';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';

export interface TransferAllOptions extends NetworkOption {
  privkey?: string | null;
}

export async function transferAll(toAddress: string, opt: TransferAllOptions = { network: Network.devnet }) {
  const network = opt.network;
  validateNetworkOpt(network);

  if (opt.privkey == null) {
    throw new Error('--privkey is required!');
  }

  const privateKey = opt.privkey;
  const ckb = new CKB({ network });

  const txHash = await ckb.transferAll({
    toAddress,
    privateKey,
  });
  if (network === 'testnet') {
    console.log(`Successfully transfer, check ${buildTestnetTxLink(txHash)} for details.`);
    return;
  }

  console.log('Successfully transfer, txHash:', txHash);
}
