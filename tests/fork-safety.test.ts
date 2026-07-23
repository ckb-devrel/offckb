let mockFork: { source: 'mainnet' | 'testnet'; forkBlockNumber?: string } | null = null;

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({ devnet: { configPath: '/tmp/offckb-devnet' } }),
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => mockFork }));
jest.mock('../src/util/logger', () => ({ logger: { warn: jest.fn() } }));

import accountConfig from '../account/account.json';
import { validateMainnetForkSigning, warnIfMainnetForkSigning } from '../src/util/fork-safety';
import { logger } from '../src/util/logger';
import { Network } from '../src/type/base';

describe('Mainnet fork signing warning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFork = null;
  });

  it('shows the replay warning for a built-in dev key', () => {
    mockFork = { source: 'mainnet' };
    warnIfMainnetForkSigning(Network.devnet, accountConfig[0].privkey);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('REPLAY RISK')]));
  });

  it('adds a high-signal warning for an external key', () => {
    mockFork = { source: 'mainnet' };
    warnIfMainnetForkSigning(Network.devnet, '0x' + '11'.repeat(32));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('non-built-in private key'));
  });

  it('does not warn on pure devnet or public Testnet commands', () => {
    warnIfMainnetForkSigning(Network.devnet, accountConfig[0].privkey);
    mockFork = { source: 'mainnet' };
    warnIfMainnetForkSigning(Network.testnet, accountConfig[0].privkey);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('requires an explicit override for an external key', () => {
    mockFork = { source: 'mainnet', forkBlockNumber: '100' };
    expect(() => validateMainnetForkSigning(Network.devnet, '0x' + '11'.repeat(32))).toThrow(
      '--allow-external-key-on-mainnet-fork',
    );
  });

  it('returns the fork boundary after an explicit external-key override', () => {
    mockFork = { source: 'mainnet', forkBlockNumber: '100' };
    expect(validateMainnetForkSigning(Network.devnet, '0x' + '11'.repeat(32), true)).toBe(100n);
  });

  it('fails closed when fork boundary metadata is missing', () => {
    mockFork = { source: 'mainnet' };
    expect(() => validateMainnetForkSigning(Network.devnet, accountConfig[0].privkey)).toThrow(
      'boundary metadata is missing',
    );
  });

  it('rejects a negative fork boundary', () => {
    mockFork = { source: 'mainnet', forkBlockNumber: '-1' };
    expect(() => validateMainnetForkSigning(Network.devnet, accountConfig[0].privkey)).toThrow(
      'Invalid Mainnet fork boundary metadata',
    );
  });
});
