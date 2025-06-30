import { CKB } from '../sdk/ckb';
import { ckbDevnetMinerAccount } from '../cfg/account';
import { NetworkOption, Network } from '../type/base';
import { buildTestnetTxLink } from '../util/link';
import { validateNetworkOpt } from '../util/validator';
import { Request } from '../util/request';
import { RequestInit } from 'node-fetch';

export interface DepositOptions extends NetworkOption {}

export async function deposit(
  toAddress: string,
  amountInCKB: string,
  opt: DepositOptions = { network: Network.devnet },
) {
  const network = opt.network;
  validateNetworkOpt(network);

  const ckb = new CKB({ network });

  if (network === 'testnet') {
    return await depositFromTestnetFaucet(toAddress, ckb);
  }

  // deposit from devnet miner
  const privateKey = ckbDevnetMinerAccount.privkey;
  const txHash = await ckb.transfer({
    toAddress,
    privateKey,
    amountInCKB,
  });
  console.log('tx hash: ', txHash);
}

async function depositFromTestnetFaucet(ckbAddress: string, ckb: CKB) {
  console.log('testnet faucet only supports fixed-amount claim: 10,000 CKB');

  const randomAccountPrivateKey = '0x' + generateHex(64);
  const randomAccountAddress = await ckb.buildSecp256k1Address(randomAccountPrivateKey);

  console.log(
    `use random account to claim from faucet: \n\nprivate key: ${randomAccountPrivateKey}\n\n address: ${randomAccountAddress}`,
  );
  try {
    const claimResponse = await sendClaimRequest(randomAccountAddress);

    console.log('Wait for claim transaction confirmed to transfer all from random account to your account..');
    console.log('You can transfer by yourself if it ends up fails..');
    if (claimResponse.txHash != null) {
      await ckb.waitForTxConfirm(claimResponse.txHash);
    } else {
      await ckb.waitForBlocksBy(4); // wait 4 blocks
    }
  } catch (error) {
    console.log(error);
    throw new Error('claim request failed.');
  }

  const txHash = await ckb.transferAll({ privateKey: randomAccountPrivateKey, toAddress: ckbAddress });
  console.log(`Done, check ${buildTestnetTxLink(txHash)} for details.`);
}

async function sendClaimRequest(toAddress: string) {
  const url = 'https://faucet-api.nervos.org/claim_events'; // Replace 'YOUR_API_ENDPOINT' with the actual API endpoint

  const headers = {
    'User-Agent': 'node-fetch-requests/v2',
    'Accept-Encoding': 'gzip, deflate',
    Accept: '*/*',
    Connection: 'keep-alive',
    'Content-Type': 'application/json',
  };

  const body = JSON.stringify({
    claim_event: {
      address_hash: toAddress,
      amount: '10000', // unit: CKB
    },
  });

  const config: RequestInit = {
    method: 'post',
    headers: headers,
    body,
  };

  const response = await Request.send(url, config);
  console.log('send claim request, status: ', response.status); // Handle the response data here
  const jsonResponse = await response.json();
  return jsonResponse.data.attributes as {
    addressHash: string;
    status: 'pending' | 'commit';
    txHash: string | null;
    txStatus: 'pending' | 'commit';
    id: number;
    timestamp: number;
    fee: string;
    capacity: string; // unit: CKB
  };
}

function generateHex(length: number) {
  const characters = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters[Math.floor(Math.random() * characters.length)];
  }
  return result;
}
