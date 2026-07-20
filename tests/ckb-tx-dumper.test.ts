import fs from 'fs';
import os from 'os';
import path from 'path';

const HEADER_A = '0x' + 'aa'.repeat(32);
const HEADER_B = '0x' + 'bb'.repeat(32);

const mockGetCell = jest.fn();
const mockCallJsonRpc = jest.fn();

jest.mock('@ckb-ccc/core', () => ({
  ccc: {
    mol: {
      struct: jest.fn(),
      vector: jest.fn(),
    },
    ClientPublicMainnet: jest.fn().mockImplementation(() => ({ getCell: mockGetCell })),
    ClientPublicTestnet: jest.fn().mockImplementation(() => ({ getCell: mockGetCell })),
    OutPoint: { from: (x: unknown) => x },
  },
}));

jest.mock('@ckb-ccc/core/advanced', () => ({
  cccA: {
    JsonRpcTransformers: {
      transactionTo: () => mockCccTx,
    },
  },
}));

jest.mock('../src/util/json-rpc', () => ({
  callJsonRpc: (...args: unknown[]) => mockCallJsonRpc(...args),
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

// a ccc-shaped Transaction with two header deps and one input
const mockCccTx = {
  version: 0,
  cellDeps: [],
  headerDeps: [HEADER_A, HEADER_B],
  inputs: [
    {
      previousOutput: { txHash: '0x' + '01'.repeat(32), index: 0 },
      since: 0,
    },
  ],
  outputs: [],
  outputsData: [],
  witnesses: [],
};

function fakeHeader(hash: string) {
  return {
    compact_target: '0x1e015555',
    dao: '0x' + '00'.repeat(32),
    epoch: '0x0',
    extra_hash: '0x' + '00'.repeat(32),
    hash,
    nonce: '0x0',
    number: '0x0',
    parent_hash: '0x' + '00'.repeat(32),
    proposals_hash: '0x' + '00'.repeat(32),
    timestamp: '0x1718c6b7ff8',
    transactions_root: '0x' + '00'.repeat(32),
    uncles_hash: '0x' + '00'.repeat(32),
    version: '0x0',
  };
}

import { dumpTransaction } from '../src/tools/ckb-tx-dumper';

describe('dumpTransaction header deps', () => {
  let dir: string;
  let txJsonFilePath: string;
  let outputFilePath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-dumper-test-'));
    txJsonFilePath = path.join(dir, 'tx.json');
    outputFilePath = path.join(dir, 'out', 'mock.json');
    fs.writeFileSync(txJsonFilePath, JSON.stringify({ minimal: true }));

    mockGetCell.mockResolvedValue({
      cellOutput: {
        capacity: 1000n,
        lock: { codeHash: '0x' + '09'.repeat(32), hashType: 'type', args: '0x' },
        type: null,
      },
      outputData: '0x',
    });
    mockCallJsonRpc.mockImplementation((_rpc: string, method: string, params: string[]) => {
      if (method === 'get_header') return Promise.resolve(fakeHeader(params[0]));
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('embeds full header objects in mock_info.header_deps', async () => {
    await dumpTransaction({ rpc: 'http://127.0.0.1:8114', txJsonFilePath, outputFilePath });

    expect(mockCallJsonRpc).toHaveBeenCalledTimes(2);
    expect(mockCallJsonRpc).toHaveBeenCalledWith('http://127.0.0.1:8114', 'get_header', [HEADER_A]);
    expect(mockCallJsonRpc).toHaveBeenCalledWith('http://127.0.0.1:8114', 'get_header', [HEADER_B]);

    const mockTx = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
    expect(mockTx.mock_info.header_deps).toHaveLength(2);
    expect(mockTx.mock_info.header_deps[0].hash).toBe(HEADER_A);
    expect(mockTx.mock_info.header_deps[1].hash).toBe(HEADER_B);
    expect(mockTx.mock_info.header_deps[0].number).toBe('0x0');
    // the tx itself still references plain hashes
    expect(mockTx.tx.header_deps).toEqual([HEADER_A, HEADER_B]);
  });

  it('throws when a header cannot be resolved', async () => {
    mockCallJsonRpc.mockResolvedValue(null);

    await expect(dumpTransaction({ rpc: 'http://127.0.0.1:8114', txJsonFilePath, outputFilePath })).rejects.toThrow(
      /Header not found/,
    );
  });
});
