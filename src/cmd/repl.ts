import { start } from 'repl';
import { ccc } from '@ckb-ccc/core';
import { cccA } from '@ckb-ccc/core/advanced';
import { networks } from '../sdk/network';
import { Network, NetworkOption } from '../type/base';
import { buildCCCDevnetKnownScripts } from '../scripts/private';
import accounts from '../../account/account.json';
import { validateNetworkOpt } from '../util/validator';
import { genSystemScripts } from '../scripts/gen';
import { readUserDeployedScriptsInfo } from '../scripts/util';

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
  context.Client = initGlobalClientBuilder(proxyRpc);
  context.client = initGlobalClientBuilder(proxyRpc).new(network);
  context.accounts = accounts;
  context.myScripts = buildMyScripts().new(network);
  context.systemScripts = buildSystemScripts().new(network);

  context.help = printHelpText;
}

export function initGlobalClientBuilder(proxyRpc: boolean) {
  return {
    new: (network: Network) => {
      if (proxyRpc) {
        return network === 'mainnet'
          ? new ccc.ClientPublicMainnet({ url: networks.mainnet.proxy_rpc_url })
          : network === 'testnet'
            ? new ccc.ClientPublicTestnet({ url: networks.testnet.proxy_rpc_url })
            : new ccc.ClientPublicTestnet({
                url: networks.devnet.proxy_rpc_url,
                scripts: buildCCCDevnetKnownScripts(),
              });
      }
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
  - myScripts, user-deployed scripts information via offckb deploy
  - systemScripts, built-in scripts information in the blockchain
  - help, print this help message
`);
}

export function buildSystemScripts() {
  return {
    new: (network: Network) => {
      const systemScripts = genSystemScripts();
      return network === Network.devnet
        ? systemScripts?.devnet
        : network === Network.testnet
          ? systemScripts?.testnet
          : systemScripts?.mainnet;
    },
  };
}

export function buildMyScripts() {
  return {
    new: (network: Network) => {
      return readUserDeployedScriptsInfo(network);
    },
  };
}
