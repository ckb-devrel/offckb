import { ccc } from '@ckb-ccc/core';
import { CKB, UdtKind } from '../../src/sdk/ckb';
import { Network } from '../../src/type/base';
import { logger } from '../../src/util/logger';

jest.mock('../../src/sdk/network', () => ({
  networks: {
    devnet: { rpc_url: 'http://localhost:8114', proxy_rpc_url: 'http://localhost:8114' },
    testnet: { rpc_url: 'http://testnet', proxy_rpc_url: 'http://testnet' },
    mainnet: { rpc_url: 'http://mainnet', proxy_rpc_url: 'http://mainnet' },
  },
}));

jest.mock('../../src/scripts/private', () => ({
  buildDevnetCCCClient: jest.fn(() => mockClient),
  getDevnetSystemScriptsFromListHashes: jest.fn(() => ({
    sudt: {
      script: {
        codeHash: '0x' + 'c3'.repeat(32),
        hashType: 'type',
        cellDeps: [{ cellDep: { outPoint: { txHash: '0x' + 'aa'.repeat(32), index: 0 }, depType: 'depGroup' } }],
      },
    },
  })),
}));

const mockKnownScript = jest.fn();
const mockFindCellsByLock = jest.fn();
const mockFindCells = jest.fn();
const mockGetTransactionNoCache = jest.fn();
const mockClient = {
  getKnownScript: mockKnownScript,
  findCellsByLock: mockFindCellsByLock,
  findCells: mockFindCells,
  getTransactionNoCache: mockGetTransactionNoCache,
};

jest.mock('@ckb-ccc/core', () => {
  return {
    ccc: {
      ClientPublicTestnet: jest.fn(() => mockClient),
      ClientPublicMainnet: jest.fn(() => mockClient),
      Address: {
        fromString: jest.fn(async (address: string) => ({
          script: {
            codeHash: '0x' + '00'.repeat(32),
            hashType: 'type',
            args: address.startsWith('ckt1') ? '0x' + '11'.repeat(20) : '0x' + '22'.repeat(20),
          },
        })),
      },
      Script: {
        fromKnownScript: jest.fn(async (_client: unknown, script: unknown, args: string) => ({
          codeHash: script === 'XUdt' ? '0x' + 'dd'.repeat(32) : '0x' + 'cc'.repeat(32),
          hashType: 'type',
          args,
        })),
        from: jest.fn((script: unknown) => script),
      },
      KnownScript: { XUdt: 'XUdt', TypeId: 'TypeId' },
      udtBalanceFrom: jest.fn((data: string) => {
        if (!data || data === '0x') return 0n;
        if (data === '0xbad') throw new Error('corrupted');
        return BigInt(data);
      }),
      fixedPointFrom: jest.fn((value: string | number) => BigInt(value) * BigInt(10 ** 8)),
      numToBytes: jest.fn((value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, '0')),
      hexFrom: jest.fn((value: string) => '0x' + value),
      Transaction: {
        from: jest.fn(() => ({
          outputs: [],
          outputsData: [],
          inputs: [],
          cellDeps: [],
          addCellDeps: jest.fn(),
          addInput: jest.fn(),
          addOutput: jest.fn(),
          completeInputsByUdt: jest.fn(),
          completeInputsByCapacity: jest.fn(),
          completeFeeBy: jest.fn(),
          getInputsUdtBalance: jest.fn().mockResolvedValue(0n),
          getOutputsUdtBalance: jest.fn().mockReturnValue(0n),
        })),
      },
      CellOutput: {
        from: jest.fn((output: unknown) => output),
      },
      SignerCkbPrivateKey: jest.fn(() => ({
        getAddressObjSecp256k1: jest.fn().mockResolvedValue({
          script: { hash: () => '0x' + '00'.repeat(32) },
        }),
        sendTransaction: jest.fn().mockResolvedValue('0xtxhash'),
      })),
    },
  };
});

function createCKB(network: Network = Network.devnet) {
  return new CKB({ network, isEnableProxyRpc: false });
}

describe('CKB SDK UDT helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKnownScript.mockResolvedValue({
      codeHash: '0x' + 'dd'.repeat(32),
      hashType: 'type',
      cellDeps: [{ cellDep: { outPoint: { txHash: '0x' + 'aa'.repeat(32), index: 0 }, depType: 'depGroup' } }],
    });
  });

  describe('buildUdtTypeScript', () => {
    it('should build xUDT type script from known script', async () => {
      const ckb = createCKB();
      const type = await ckb.buildUdtTypeScript('xudt', '0x' + '12'.repeat(32));
      expect(type.codeHash).toBe('0x' + 'dd'.repeat(32));
      expect(type.args).toBe('0x' + '12'.repeat(32));
    });

    it('should build SUDT type script from system scripts', async () => {
      const ckb = createCKB();
      const type = await ckb.buildUdtTypeScript('sudt', '0x' + '12'.repeat(32));
      expect(type.codeHash).toBe('0x' + 'c3'.repeat(32));
      expect(type.args).toBe('0x' + '12'.repeat(32));
    });
  });

  describe('detectUdtBalances', () => {
    beforeEach(() => {
      mockFindCells.mockImplementation(async function* (searchKey: { script: { codeHash: string } }) {
        const isSudt = searchKey.script.codeHash === '0x' + 'c3'.repeat(32);
        if (isSudt) {
          yield makeCell('sudt', '0xabcd', '100');
          yield makeCell('sudt', '0xabcd', '200');
        } else {
          yield makeCell('xudt', '0xbeef', '50');
        }
      });
    });

    it('should aggregate UDT balances by kind and args', async () => {
      const ckb = createCKB();

      const balances = await ckb.detectUdtBalances('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9');

      expect(balances).toHaveLength(2);
      expect(balances.find((b) => b.kind === 'sudt' && b.args === '0xabcd')?.balance).toBe('300');
      expect(balances.find((b) => b.kind === 'xudt' && b.args === '0xbeef')?.balance).toBe('50');
    });

    it('should skip corrupted UDT cells instead of failing', async () => {
      mockFindCells.mockImplementation(async function* (searchKey: { script: { codeHash: string } }) {
        const isSudt = searchKey.script.codeHash === '0x' + 'c3'.repeat(32);
        if (!isSudt) {
          return;
        }
        yield makeCell('sudt', '0xabcd', '100');
        yield makeCell('sudt', '0xabcd', '0xbad');
        yield makeCell('sudt', '0xabcd', '200');
      });

      const ckb = createCKB();
      const balances = await ckb.detectUdtBalances('ckt1q9gry5zgmceslalm9x6s5xgnqe9cjn6y0q3c9');

      expect(balances).toHaveLength(1);
      expect(balances[0].balance).toBe('300');
    });
  });

  describe('udtIssue type args handling', () => {
    it('should warn when SUDT issue receives a user type args', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const ckb = createCKB();

      await ckb.udtIssue({
        privateKey: '0x' + '11'.repeat(32),
        kind: 'sudt',
        amount: '100',
        typeArgs: '0x' + '12'.repeat(32),
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--type-args is ignored'));
      warnSpy.mockRestore();
    });
  });

  describe('Mainnet fork input boundary', () => {
    const input = { previousOutput: { txHash: '0x' + 'ab'.repeat(32), index: 0 } };

    it('rejects an input copied from at or before the fork boundary', async () => {
      mockGetTransactionNoCache.mockResolvedValue({ blockNumber: 100n });
      const ckb = createCKB();

      await expect(
        (
          ckb as unknown as {
            assertInputsCreatedAfter: (tx: { inputs: (typeof input)[] }, block: bigint) => Promise<void>;
          }
        ).assertInputsCreatedAfter({ inputs: [input] }, 100n),
      ).rejects.toThrow('at or before the Mainnet fork boundary');
    });

    it('allows an input mined after the fork boundary', async () => {
      mockGetTransactionNoCache.mockResolvedValue({ blockNumber: 101n });
      const ckb = createCKB();

      await expect(
        (
          ckb as unknown as {
            assertInputsCreatedAfter: (tx: { inputs: (typeof input)[] }, block: bigint) => Promise<void>;
          }
        ).assertInputsCreatedAfter({ inputs: [input] }, 100n),
      ).resolves.toBeUndefined();
    });

    it('fails closed when an input origin cannot be verified', async () => {
      mockGetTransactionNoCache.mockResolvedValue(undefined);
      const ckb = createCKB();

      await expect(
        (
          ckb as unknown as {
            assertInputsCreatedAfter: (tx: { inputs: (typeof input)[] }, block: bigint) => Promise<void>;
          }
        ).assertInputsCreatedAfter({ inputs: [input] }, 100n),
      ).rejects.toThrow('could not verify the origin block');
    });
  });

  describe('udtDestroy', () => {
    const typeArgs = '0x' + '12'.repeat(32);
    const privateKey = '0x' + '11'.repeat(32);
    const signerCtor = ccc.SignerCkbPrivateKey as unknown as jest.Mock;

    beforeEach(() => {
      mockFindCellsByLock.mockReset();
    });

    const seedCells = (kind: UdtKind) => {
      mockFindCellsByLock.mockImplementation(async function* () {
        yield makeCell(kind, typeArgs, '100', 0);
        yield makeCell(kind, typeArgs, '200', 1);
      });
    };

    it.each(['sudt', 'xudt'] as const)('destroys the full balance (%s) and keeps a zero-balance cell', async (kind) => {
      seedCells(kind);
      const ckb = createCKB();

      const txHash = await ckb.udtDestroy({ privateKey, kind, typeArgs, amount: '300' });

      expect(txHash).toBe('0xtxhash');

      const signer = signerCtor.mock.results[0].value as {
        getAddressObjSecp256k1: () => Promise<{ script: { hash: () => string } }>;
        sendTransaction: jest.Mock;
      };
      const from = await signer.getAddressObjSecp256k1();
      const sendTx = signer.sendTransaction;
      expect(sendTx).toHaveBeenCalledTimes(1);
      const tx = sendTx.mock.calls[0][0] as {
        addInput: jest.Mock;
        addOutput: jest.Mock;
        addCellDeps: jest.Mock;
        completeInputsByCapacity: jest.Mock;
        completeFeeBy: jest.Mock;
      };

      expect(tx.addInput).toHaveBeenCalledTimes(2);
      expect(tx.addInput).toHaveBeenCalledWith({ previousOutput: { txHash: '0x' + '00'.repeat(32), index: 0 } });
      expect(tx.addInput).toHaveBeenCalledWith({ previousOutput: { txHash: '0x' + '00'.repeat(32), index: 1 } });

      expect(tx.addOutput).toHaveBeenCalledTimes(1);
      const [output, data] = tx.addOutput.mock.calls[0] as [Record<string, unknown>, string];
      expect(output.lock).toBe(from.script);
      expect(output.type).toEqual({
        codeHash: kind === 'sudt' ? '0x' + 'c3'.repeat(32) : '0x' + 'dd'.repeat(32),
        hashType: 'type',
        args: typeArgs,
      });
      expect(output.capacity).toBe(0n);
      expect(data).toBe('0x' + '00'.repeat(16));

      expect(tx.addCellDeps).toHaveBeenCalledWith([
        { outPoint: { txHash: '0x' + 'aa'.repeat(32), index: 0 }, depType: 'depGroup' },
      ]);
      expect(tx.completeInputsByCapacity).toHaveBeenCalledTimes(1);
      expect(tx.completeFeeBy).toHaveBeenCalledTimes(1);
    });

    it.each(['sudt', 'xudt'] as const)('destroys part of the balance (%s) and returns the remainder', async (kind) => {
      seedCells(kind);
      const ckb = createCKB();

      const txHash = await ckb.udtDestroy({ privateKey, kind, typeArgs, amount: '100' });

      expect(txHash).toBe('0xtxhash');
      const signer = signerCtor.mock.results[0].value as { sendTransaction: jest.Mock };
      const tx = signer.sendTransaction.mock.calls[0][0] as { addOutput: jest.Mock };
      expect(tx.addOutput).toHaveBeenCalledTimes(1);
      // The numToBytes mock is not a real little-endian encoder, so assert the call args rather than the encoded hex.
      expect(ccc.numToBytes as unknown as jest.Mock).toHaveBeenCalledWith(200n, 16);
    });

    it('rejects an amount above the total balance without sending', async () => {
      seedCells('sudt');
      const ckb = createCKB();

      await expect(ckb.udtDestroy({ privateKey, kind: 'sudt', typeArgs, amount: '301' })).rejects.toThrow(
        'Insufficient UDT balance: 300 < 301',
      );

      const signer = signerCtor.mock.results[0].value as { sendTransaction: jest.Mock };
      expect(signer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects a zero amount without sending', async () => {
      const ckb = createCKB();

      await expect(ckb.udtDestroy({ privateKey, kind: 'sudt', typeArgs, amount: '0' })).rejects.toThrow(
        'invalid UDT amount "0"',
      );

      const signer = signerCtor.mock.results[0].value as { sendTransaction: jest.Mock };
      expect(signer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects when input cells exceed maxInputCells without sending', async () => {
      seedCells('sudt');
      const ckb = createCKB();

      await expect(
        ckb.udtDestroy({ privateKey, kind: 'sudt', typeArgs, amount: '300' }, { maxInputCells: 1 }),
      ).rejects.toThrow('Too many UDT cells to destroy');

      const signer = signerCtor.mock.results[0].value as { sendTransaction: jest.Mock };
      expect(signer.sendTransaction).not.toHaveBeenCalled();
    });
  });
});

function makeCell(kind: UdtKind, args: string, balance: string, index = 0) {
  const codeHash = kind === 'sudt' ? '0x' + 'c3'.repeat(32) : '0x' + 'dd'.repeat(32);
  return {
    outPoint: { txHash: '0x' + '00'.repeat(32), index },
    cellOutput: {
      type: { codeHash, hashType: 'type', args },
    },
    outputData: balance,
  };
}
