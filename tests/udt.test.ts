import { Network } from '../src/type/base';
import { udtBalance, udtTransfer } from '../src/cmd/udt';
import { CKB } from '../src/sdk/ckb';
import { logger } from '../src/util/logger';

jest.mock('../src/sdk/ckb', () => {
  const mockUdtType = { codeHash: '0x1234', hashType: 'type', args: '0xabcd' };
  return {
    CKB: jest.fn().mockImplementation(() => ({
      buildUdtTypeScript: jest.fn().mockResolvedValue(mockUdtType),
      udtBalance: jest.fn().mockResolvedValue('1000'),
      udtTransfer: jest.fn().mockResolvedValue('0xtxhash'),
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

describe('udt command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('udtBalance', () => {
    it('should print UDT balance', async () => {
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);

      await udtBalance('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', {
        network: Network.devnet,
        kind: 'sudt',
        typeArgs: '0xabcd',
      });

      const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
      expect(ckbInstance.buildUdtTypeScript).toHaveBeenCalledWith('sudt', '0xabcd');
      expect(ckbInstance.udtBalance).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('UDT Balance: 1000');
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });
  });

  describe('udtTransfer', () => {
    it('should throw when privkey is missing', async () => {
      await expect(
        udtTransfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
          network: Network.devnet,
          kind: 'sudt',
          typeArgs: '0xabcd',
          privkey: '',
        }),
      ).rejects.toThrow('--privkey is required!');
    });

    it('should transfer UDT with privkey', async () => {
      await udtTransfer('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9', '100', {
        network: Network.devnet,
        kind: 'sudt',
        typeArgs: '0xabcd',
        privkey: '0x1234567812345678123456781234567812345678123456781234567812345678',
      });

      const ckbInstance = (CKB as jest.Mock).mock.results[0].value;
      expect(ckbInstance.udtTransfer).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Successfully transfer UDT, txHash:', '0xtxhash');
    });
  });
});
