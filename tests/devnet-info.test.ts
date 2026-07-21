let mockFork: { source: 'mainnet' | 'testnet' } | null = null;
const mockReadiness = jest.fn();

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: { configPath: '/tmp/devnet', rpcUrl: 'http://127.0.0.1:8114', rpcProxyPort: 28114 },
  }),
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => mockFork }));
jest.mock('../src/devnet/readiness', () => ({ checkNodeReadiness: (...args: unknown[]) => mockReadiness(...args) }));
jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), result: jest.fn() },
}));

import { devnetInfo } from '../src/cmd/devnet-info';
import { logger } from '../src/util/logger';

describe('devnet info', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFork = null;
  });

  it('warns when indexed queries lag behind the node', async () => {
    mockReadiness.mockResolvedValue({
      ready: true,
      nodeTip: 100n,
      indexerTip: 90n,
      indexerLag: 10n,
      peers: 0,
    });

    await devnetInfo();

    expect(logger.warn).toHaveBeenCalledWith('Indexer lag: 10; indexed queries may be stale.');
    expect(logger.info).not.toHaveBeenCalledWith('Indexer lag: 10');
  });

  it('logs zero lag as informational', async () => {
    mockReadiness.mockResolvedValue({
      ready: true,
      nodeTip: 100n,
      indexerTip: 100n,
      indexerLag: 0n,
      peers: 0,
    });

    await devnetInfo();

    expect(logger.info).toHaveBeenCalledWith('Indexer lag: 0');
  });
});
