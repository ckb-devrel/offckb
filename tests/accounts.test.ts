let mockFork: { source: 'mainnet' | 'testnet' } | null = null;

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({ devnet: { configPath: '/tmp/offckb-devnet', rpcUrl: 'http://127.0.0.1:8114' } }),
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => mockFork }));
jest.mock('../src/devnet/readiness', () => ({ warnIfForkIndexerIsBehind: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/util/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    result: jest.fn(),
  },
}));

import { accounts } from '../src/cmd/accounts';
import { logger } from '../src/util/logger';

describe('accounts command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFork = null;
  });

  it('uses ckt addresses and the genesis funding statement on a pure devnet', async () => {
    const result = await accounts();
    expect(result[0].address).toMatch(/^ckt1/);
    expect(result[0].privkey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(logger.info).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringMatching(/^privkey: 0x[0-9a-f]{64}$/)]),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('funded with 42_000_000_00000000')]),
    );
  });

  it('re-encodes built-in dev accounts with ckb on a Mainnet fork', async () => {
    mockFork = { source: 'mainnet' };
    const result = await accounts();
    expect(result[0].address).toMatch(/^ckb1/);
    expect(result[0].privkey).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('hidden by default on a Mainnet fork'));
    expect(logger.info).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('do not include the standard offckb genesis allocation')]),
    );
    expect(logger.result).toHaveBeenCalledWith(expect.objectContaining({ context: 'DEVNET (fork of MAINNET)' }));
  });

  it('shows dev private keys on a Testnet fork', async () => {
    mockFork = { source: 'testnet' };
    const result = await accounts();
    expect(result[0].privkey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reveals dev private keys on a Mainnet fork after an explicit option', async () => {
    mockFork = { source: 'mainnet' };
    const result = await accounts({ showPrivateKeys: true });
    expect(result[0].privkey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('omits private keys with --hide-private-keys', async () => {
    const result = await accounts({ hidePrivateKeys: true });
    expect(result[0].privkey).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringMatching(/^privkey:/)]));
    expect(logger.result).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([expect.not.objectContaining({ privkey: expect.anything() })]),
      }),
    );
  });
});
