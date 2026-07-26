import { buildTxFileOptionBy } from '../src/cmd/debug';
import { Network } from '../src/type/base';

const mockExistsSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

const mockCallJsonRpc = jest.fn();
jest.mock('../src/util/json-rpc', () => ({
  callJsonRpc: (...args: unknown[]) => mockCallJsonRpc(...args),
}));

const mockDumpTransaction = jest.fn();
jest.mock('../src/tools/ckb-tx-dumper', () => ({
  dumpTransaction: (...args: unknown[]) => mockDumpTransaction(...args),
}));

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: {
      rpcUrl: 'http://127.0.0.1:8114',
      debugFullTransactionsPath: '/tmp/offckb/devnet/full-transactions',
      transactionsPath: '/tmp/offckb/devnet/transactions',
    },
    testnet: {
      rpcUrl: 'https://testnet.ckb.dev',
      debugFullTransactionsPath: '/tmp/offckb/testnet/full-transactions',
      transactionsPath: '/tmp/offckb/testnet/transactions',
    },
    mainnet: {
      rpcUrl: 'https://mainnet.ckb.dev',
      debugFullTransactionsPath: '/tmp/offckb/mainnet/full-transactions',
      transactionsPath: '/tmp/offckb/mainnet/transactions',
    },
  }),
}));

jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setJsonMode: jest.fn(),
  },
}));

const TX_HASH = '0x' + 'ab'.repeat(32);
const TX_JSON_PATH = `/tmp/offckb/devnet/transactions/${TX_HASH}.json`;
const OUTPUT_PATH = `/tmp/offckb/devnet/full-transactions/${TX_HASH}.json`;

describe('buildTxFileOptionBy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when the dumped mock tx already exists', async () => {
    mockExistsSync.mockReturnValue(true);

    const opt = await buildTxFileOptionBy(TX_HASH, Network.devnet);

    expect(opt).toBe(`--tx-file "${OUTPUT_PATH}"`);
    expect(mockCallJsonRpc).not.toHaveBeenCalled();
    expect(mockDumpTransaction).not.toHaveBeenCalled();
  });

  it('dumps directly from the proxy-cached tx json when present', async () => {
    mockExistsSync.mockImplementation((p: string) => p === TX_JSON_PATH);

    await buildTxFileOptionBy(TX_HASH, Network.devnet);

    expect(mockCallJsonRpc).not.toHaveBeenCalled();
    expect(mockDumpTransaction).toHaveBeenCalledWith({
      rpc: 'http://127.0.0.1:8114',
      txJsonFilePath: TX_JSON_PATH,
      outputFilePath: OUTPUT_PATH,
    });
  });

  it('falls back to get_transaction when the tx json is not cached locally', async () => {
    mockExistsSync.mockReturnValue(false);
    const rpcTx = { version: '0x0', cell_deps: [], inputs: [], outputs: [], outputs_data: [], witnesses: [] };
    mockCallJsonRpc.mockResolvedValue({ transaction: rpcTx, tx_status: { status: 'committed' } });

    const opt = await buildTxFileOptionBy(TX_HASH, Network.devnet);

    expect(mockCallJsonRpc).toHaveBeenCalledWith('http://127.0.0.1:8114', 'get_transaction', [TX_HASH]);
    expect(mockWriteFileSync).toHaveBeenCalledWith(TX_JSON_PATH, JSON.stringify(rpcTx, null, 2));
    expect(mockDumpTransaction).toHaveBeenCalledWith({
      rpc: 'http://127.0.0.1:8114',
      txJsonFilePath: TX_JSON_PATH,
      outputFilePath: OUTPUT_PATH,
    });
    expect(opt).toBe(`--tx-file "${OUTPUT_PATH}"`);
  });

  it('throws an actionable error when the transaction does not exist on the node', async () => {
    mockExistsSync.mockReturnValue(false);
    mockCallJsonRpc.mockResolvedValue(null);

    await expect(buildTxFileOptionBy(TX_HASH, Network.devnet)).rejects.toThrow(
      `Transaction ${TX_HASH} not found on http://127.0.0.1:8114`,
    );
    expect(mockDumpTransaction).not.toHaveBeenCalled();
  });

  it('wraps RPC failures with context', async () => {
    mockExistsSync.mockReturnValue(false);
    mockCallJsonRpc.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(buildTxFileOptionBy(TX_HASH, Network.devnet)).rejects.toThrow(
      `Failed to fetch transaction ${TX_HASH} from http://127.0.0.1:8114: connect ECONNREFUSED`,
    );
  });

  it('rejects a malformed tx hash before touching any cache path', async () => {
    for (const badHash of ['0x../escape', 'not-a-hash', '0x' + 'ab'.repeat(31), '0x' + 'ab'.repeat(33)]) {
      await expect(buildTxFileOptionBy(badHash, Network.devnet)).rejects.toThrow('invalid transaction hash');
    }

    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockCallJsonRpc).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockDumpTransaction).not.toHaveBeenCalled();
  });
});
