import { Network } from '../src/type/base';
import { balanceOf } from '../src/cmd/balance';
import { transfer } from '../src/cmd/transfer';
import { udtIssue, udtDestroy } from '../src/cmd/udt';
import { CKB } from '../src/sdk/ckb';
import { logger } from '../src/util/logger';

const mockUdtType = { codeHash: '0x1234', hashType: 'type', args: '0xabcd' };

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
          args: '0xabcd',
          balance: '1000',
        },
      ]),
      udtTransfer: jest.fn().mockResolvedValue('0xtxhash'),
      udtIssue: jest.fn().mockResolvedValue('0xissuehash'),
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
  },
}));

describe('balance command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should print CKB and detected UDT balances by default', async () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await balanceOf('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.balance).toHaveBeenCalled();
    expect(ckbInstance.detectUdtBalances).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('CKB: 1234.5678');
    expect(logger.info).toHaveBeenCalledWith('UDT:');
    expect(logger.info).toHaveBeenCalledWith('  sudt (args=0xabcd): 1000');
    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it('should filter UDT balances by kind and type args', async () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await balanceOf('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
      network: Network.devnet,
      udtKind: 'sudt',
      udtTypeArgs: '0xabcd',
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.detectUdtBalances).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('  sudt (args=0xabcd): 1000');

    mockExit.mockRestore();
  });
});

describe('transfer command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('should transfer UDT when --udt-type-args is provided', async () => {
    await transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
      network: Network.devnet,
      privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      udtTypeArgs: '0xabcd',
      udtKind: 'sudt',
    });

    const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
    expect(ckbInstance.buildUdtTypeScript).toHaveBeenCalledWith('sudt', '0xabcd');
    expect(ckbInstance.udtTransfer).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Successfully transfer UDT, txHash:', '0xtxhash');
  });

  it('should throw when privkey is missing for UDT transfer', async () => {
    await expect(
      transfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
        network: Network.devnet,
        udtTypeArgs: '0xabcd',
      }),
    ).rejects.toThrow('--privkey is required!');
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
          kind: 'sudt',
          privkey: '',
        }),
      ).rejects.toThrow('--privkey is required!');
    });

    it('should issue UDT with privkey', async () => {
      await udtIssue('100', {
        network: Network.devnet,
        kind: 'sudt',
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
          kind: 'sudt',
          typeArgs: '0xabcd',
          privkey: '',
        }),
      ).rejects.toThrow('--privkey is required!');
    });

    it('should destroy UDT with privkey', async () => {
      await udtDestroy('100', {
        network: Network.devnet,
        kind: 'sudt',
        typeArgs: '0xabcd',
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      });

      const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
      expect(ckbInstance.udtDestroy).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Successfully destroyed UDT, txHash:', '0xdestroyhash');
    });
  });
});
