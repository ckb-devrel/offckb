const mockCallJsonRpc = jest.fn();
let mockFork: { source: 'mainnet' | 'testnet' } | null = { source: 'mainnet' };

jest.mock('../src/util/json-rpc', () => ({
  callJsonRpc: (...args: unknown[]) => mockCallJsonRpc(...args),
}));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({ devnet: { configPath: '/tmp/offckb-devnet', rpcUrl: 'http://127.0.0.1:8114' } }),
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => mockFork }));
jest.mock('../src/util/logger', () => ({ logger: { warn: jest.fn() } }));

import { warnIfForkIndexerIsBehind } from '../src/devnet/readiness';
import { logger } from '../src/util/logger';
import { Network } from '../src/type/base';

describe('fork Indexer warning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFork = { source: 'mainnet' };
    mockCallJsonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'local_node_info') return { version: '0.207.0' };
      if (method === 'get_tip_block_number') return '0x64';
      if (method === 'get_indexer_tip') return { block_number: '0x5a' };
      if (method === 'get_peers') return [];
      throw new Error(method);
    });
  });

  it('warns with the exact lag before cell-dependent operations', async () => {
    await warnIfForkIndexerIsBehind(Network.devnet);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('10 blocks behind'));
  });

  it('does nothing outside a forked devnet', async () => {
    mockFork = null;
    await warnIfForkIndexerIsBehind(Network.devnet);
    await warnIfForkIndexerIsBehind(Network.testnet);
    expect(mockCallJsonRpc).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
