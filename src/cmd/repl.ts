import { start } from 'repl';
import { ccc } from '@ckb-ccc/core';
import { cccA } from '@ckb-ccc/core/advanced';
import { networks } from '../sdk/network';
import { Network, NetworkOption } from '../type/base';
import { buildCCCDevnetKnownScripts } from '../scripts/private';
import accounts from '../../account/account.json';
import { validateNetworkOpt } from '../util/validator';

export interface ReplProp extends NetworkOption {
  proxyRpc?: boolean;
}

export function repl({ network = Network.devnet, proxyRpc = false }: ReplProp) {
  validateNetworkOpt(network);

  console.log(
    // Note remember update the CCC version since require CCC's package.json not work
    `Welcome to OffCKB REPL!\n[[ Default Network: ${network}, enableProxyRPC: ${proxyRpc}, CCC SDK: 0.0.16-alpha.3 ]]\nType 'help()' to learn how to use.`,
  );

  const context = start({
    prompt: 'OffCKB > ',
    ignoreUndefined: true,
    useColors: true,
  }).context;

  context.ccc = ccc;
  context.cccA = cccA;
  context.networks = networks;
  context.Client = initGlobalClientBuilder();
  context.client = initGlobalClientBuilder().new(network);
  context.accounts = accounts;
  context.help = printHelpText;
}

export function initGlobalClientBuilder() {
  return {
    new: (network: Network) => {
      return network === 'mainnet'
        ? new ccc.ClientPublicMainnet()
        : network === 'testnet'
          ? new ccc.ClientPublicTestnet()
          : new ccc.ClientPublicTestnet({
              url: networks.devnet.rpc_url,
              scripts: buildCCCDevnetKnownScripts(),
            });
    },
    fromUrl: (rpcUrl: string, network: Network) => {
      return network === 'mainnet'
        ? new ccc.ClientPublicMainnet({ url: rpcUrl })
        : network === 'testnet'
          ? new ccc.ClientPublicTestnet({ url: rpcUrl })
          : new ccc.ClientPublicTestnet({
              url: rpcUrl,
              scripts: buildCCCDevnetKnownScripts(),
            });
    },
  };
}

export function printHelpText() {
  return console.log(`
OffCKB Repl, a Nodejs REPL with CKB bundles.

Global Variables to use:
  - ccc, cccA, imported from CKB Javascript SDK CCC
  - client, a CCC client instance bundle with current network
  - Client, a Wrap of CCC client class, you can build new client with
     const myClient = Client.new('devnet' | 'testnet' | 'mainnet');
     // or
     const myClient = Client.fromUrl('<your rpc url>', 'devnet' | 'testnet' | 'mainnet');
  - accounts, test accounts array from OffCKB
  - networks, network information configs
  - help, print this help message
`);
}
