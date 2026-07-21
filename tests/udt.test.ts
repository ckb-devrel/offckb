import { Network } from '../src/type/base';
import { balanceOf } from '../src/cmd/balance';
import { transfer } from '../src/cmd/transfer';
import { udtIssue, udtDestroy } from '../src/cmd/udt';
import { CKB } from '../src/sdk/ckb';
import { logger } from '../src/util/logger';

const mockTypeArgs = '0x' + 'ab'.repeat(32);
const mockUdtType = { codeHash: '0x1234', hashType: 'type', args: mockTypeArgs };
const mockValidateMainnetForkSigning = jest.fn().mockReturnValue(undefined);

jest.mock('../src/sdk/ckb', () => {
  return {
    CKB: jest.fn().mockImplementation(() => ({
      balance: jest.fn().mockResolvedValue('1234.5678'),
      transfer: jest.fn().mockResolvedValue('0xtxhash'),
      buildUdtTypeScript: jest.fn().mockResolvedValue(mockUdtType),
      detectUdtBalances: jest.fn().mockResolvedValue([
        {
          kind: 'sudt',
          codeHash: '0x1234',
          hashType: 'type',
          args: mockTypeArgs,
          balance: '1000',
        },
      ]),
      udtTransfer: jest.fn().mockResolvedValue('0xtxhash'),
      udtIssue: jest.fn().mockResolvedValue({
        txHash: '0xissuehash',
        typeArgs: mockTypeArgs,
        receiver: 'ckt1receiver',
      }),
      udtDestroy: jest.fn().mockResolvedValue('0xdestroyhash'),
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
  warnIfMainnetForkSigning: jest.fn(),
  validateMainnetForkSigning: (...args: unknown[]) => mockValidateMainnetForkSigning(...args),
}));

describe('balance command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateMainnetForkSigning.mockReturnValue(undefined);
  });

  it('should print CKB and detected UDT balances by default', async () => {
    await balanceOf('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.balance).toHaveBeenCalled();
    expect(ckbInstance.detectUdtBalances).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('CKB: 1234.5678');
    expect(logger.info).toHaveBeenCalledWith('UDT:');
    expect(logger.info).toHaveBeenCalledWith(`  sudt (args=${mockTypeArgs}): 1000`);
    expect(logger.result).toHaveBeenCalledWith(expect.objectContaining({ command: 'balance', ckb: '1234.5678' }));
  });

  it('should filter UDT balances by kind and type args', async () => {
    await balanceOf('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
      udtKind: 'sudt',
      udtTypeArgs: mockTypeArgs,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.detectUdtBalances).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(`  sudt (args=${mockTypeArgs}): 1000`);
  });

  it('should skip UDT scan with --no-udt', async () => {
    await balanceOf('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
      udt: false,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.balance).toHaveBeenCalled();
    expect(ckbInstance.detectUdtBalances).not.toHaveBeenCalled();
  });
});

describe('transfer command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateMainnetForkSigning.mockReturnValue(undefined);
  });

  it('should transfer CKB by default', async () => {
    await transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
      network: Network.devnet,
      privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.transfer).toHaveBeenCalled();
    expect(ckbInstance.udtTransfer).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Successfully transfer, txHash:', '0xtxhash');
  });

  it('passes the Mainnet fork boundary to input selection checks', async () => {
    mockValidateMainnetForkSigning.mockReturnValue(100n);
    const privateKey = '0x1234567812345678123456781234567812345678123456781234567812345678';

    await transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
      network: Network.devnet,
      privkey: privateKey,
      allowMainnetReplayRisk: true,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(mockValidateMainnetForkSigning).toHaveBeenCalledWith(Network.devnet, privateKey, true);
    expect(ckbInstance.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ rejectInputsAtOrBeforeBlock: 100n }),
    );
  });

  it('should transfer UDT when --udt-type-args is provided', async () => {
    await transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
      network: Network.devnet,
      privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      udtTypeArgs: mockTypeArgs,
      udtKind: 'sudt',
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.buildUdtTypeScript).toHaveBeenCalledWith('sudt', mockTypeArgs);
    expect(ckbInstance.udtTransfer).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Successfully transfer UDT, txHash:', '0xtxhash');
  });

  it('should reject --udt-kind without type args instead of transferring CKB', async () => {
    await expect(
      transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
        network: Network.devnet,
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
        udtKind: 'sudt',
      }),
    ).rejects.toThrow('UDT type args are required');

    expect(CKB).not.toHaveBeenCalled();
  });

  it('should reject empty UDT type args instead of transferring CKB', async () => {
    await expect(
      transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
        network: Network.devnet,
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
        udtTypeArgs: '',
      }),
    ).rejects.toThrow('UDT type args are required');

    expect(CKB).not.toHaveBeenCalled();
  });

  it('should throw when privkey is missing for UDT transfer', async () => {
    await expect(
      transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
        network: Network.devnet,
        udtTypeArgs: mockTypeArgs,
      }),
    ).rejects.toThrow('--privkey-file');
  });
});

describe('udt command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('udtIssue', () => {
    it('should throw when privkey is missing', async () => {
      await expect(
        udtIssue('100', {
          network: Network.devnet,
          udtKind: 'sudt',
          privkey: '',
        }),
      ).rejects.toThrow('--privkey-file');
    });

    it('should issue UDT with privkey', async () => {
      await udtIssue('100', {
        network: Network.devnet,
        udtKind: 'sudt',
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      });

      const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
      expect(ckbInstance.udtIssue).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Successfully issued UDT, txHash:', '0xissuehash');
    });
  });

  describe('udtDestroy', () => {
    it('should throw when privkey is missing', async () => {
      await expect(
        udtDestroy('100', {
          network: Network.devnet,
          udtKind: 'sudt',
          typeArgs: mockTypeArgs,
          privkey: '',
        }),
      ).rejects.toThrow('--privkey-file');
    });

    it('should destroy UDT with privkey', async () => {
      await udtDestroy('100', {
        network: Network.devnet,
        udtKind: 'sudt',
        typeArgs: mockTypeArgs,
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      });

      const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
      expect(ckbInstance.udtDestroy).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Successfully destroyed UDT, txHash:', '0xdestroyhash');
    });
  });
});
