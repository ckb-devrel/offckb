import { readSettings } from '../cfg/setting';

const config = readSettings();

export const networks = {
  devnet: {
    addr_prefix: 'ckt',
    rpc_url: config.devnet.rpcUrl,
    proxy_rpc_url: `http://127.0.0.1:${config.rpc.proxyPort}`,
  },
  testnet: {
    addr_prefix: 'ckt',
    rpc_url: config.testnet.rpcUrl,
    proxy_rpc_url: `http://127.0.0.1:${config.rpc.proxyPort}`,
  },
  mainnet: {
    addr_prefix: 'ckb',
    rpc_url: config.mainnet.rpcUrl,
    proxy_rpc_url: `http://127.0.0.1:${config.rpc.proxyPort}`,
  },
};
