import { Network } from '../src/type/base';
import { transferAll } from '../src/cmd/transfer-all';
import { CKB } from '../src/sdk/ckb';

const mockValidateMainnetForkSigning = jest.fn().mockReturnValue(undefined);

jest.mock('../src/sdk/ckb', () => {
  return {
    CKB: jest.fn().mockImplementation(() => ({
      transferAll: jest.fn().mockResolvedValue('0xtxhash'),
    })),
  };
});

jest.mock('../src/util/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    success: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
  },
}));

jest.mock('../src/devnet/readiness', () => ({
  warnIfForkIndexerIsBehind: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/util/fork-safety', () => ({
  validateMainnetForkSigning: (...args: unknown[]) => mockValidateMainnetForkSigning(...args),
}));

describe('transfer-all command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateMainnetForkSigning.mockReturnValue(undefined);
  });

  it('sweeps the balance with the fork replay guard enforced', async () => {
    const privateKey = '0x1234567812345678123456781234567812345678123456781234567812345678';

    await transferAll('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
      privkey: privateKey,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(mockValidateMainnetForkSigning).toHaveBeenCalledWith(Network.devnet, privateKey, undefined);
    expect(ckbInstance.transferAll).toHaveBeenCalledWith(
      expect.objectContaining({ rejectInputsAtOrBeforeBlock: undefined }),
    );
  });

  it('passes the Mainnet fork boundary to input selection checks', async () => {
    mockValidateMainnetForkSigning.mockReturnValue(100n);
    const privateKey = '0x1234567812345678123456781234567812345678123456781234567812345678';

    await transferAll('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
      privkey: privateKey,
      allowExternalKeyOnMainnetFork: true,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(mockValidateMainnetForkSigning).toHaveBeenCalledWith(Network.devnet, privateKey, true);
    expect(ckbInstance.transferAll).toHaveBeenCalledWith(
      expect.objectContaining({ rejectInputsAtOrBeforeBlock: 100n }),
    );
  });

  it('fails closed when the replay guard rejects the key', async () => {
    mockValidateMainnetForkSigning.mockImplementation(() => {
      throw new Error('Refusing to sign with a non-built-in private key on a Mainnet fork.');
    });

    await expect(
      transferAll('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
        network: Network.devnet,
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      }),
    ).rejects.toThrow('Refusing to sign');

    expect(CKB).not.toHaveBeenCalled();
  });
});
