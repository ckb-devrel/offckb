let mockFork: { source: 'mainnet' | 'testnet' } | null = null;

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({ devnet: { configPath: '/tmp/offckb-devnet' } }),
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: () => mockFork }));
jest.mock('../src/util/logger', () => ({ logger: { warn: jest.fn() } }));

import accountConfig from '../account/account.json';
import { warnIfMainnetForkSigning } from '../src/util/fork-safety';
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
});
