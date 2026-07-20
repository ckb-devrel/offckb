import { Network } from '../src/type/base';

const mockBuildAddress = jest.fn().mockResolvedValue('ckt1random');
const mockWaitForTxConfirm = jest.fn().mockResolvedValue(undefined);
const mockTransferAll = jest.fn().mockResolvedValue('0xtransferhash');
const mockRequestSend = jest.fn().mockResolvedValue({
  status: 200,
  json: async () => ({ data: { attributes: { txHash: '0xclaimhash' } } }),
});

jest.mock('../src/sdk/ckb', () => ({
  CKB: jest.fn().mockImplementation(() => ({
    buildSecp256k1Address: mockBuildAddress,
    waitForTxConfirm: mockWaitForTxConfirm,
    transferAll: mockTransferAll,
  })),
}));
jest.mock('../src/util/request', () => ({ Request: { send: (...args: unknown[]) => mockRequestSend(...args) } }));
jest.mock('../src/util/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), result: jest.fn() },
}));
jest.mock('../src/devnet/readiness', () => ({ warnIfForkIndexerIsBehind: jest.fn() }));
jest.mock('../src/util/fork-safety', () => ({ warnIfMainnetForkSigning: jest.fn() }));

import { deposit } from '../src/cmd/deposit';
import { logger } from '../src/util/logger';

describe('deposit command', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns and reports the Testnet faucet transfer hash', async () => {
    await expect(deposit('ckt1receiver', '10000', { network: Network.testnet })).resolves.toBe('0xtransferhash');

    expect(mockWaitForTxConfirm).toHaveBeenCalledWith('0xclaimhash');
    expect(mockTransferAll).toHaveBeenCalledWith(
      expect.objectContaining({ toAddress: 'ckt1receiver', privateKey: expect.stringMatching(/^0x[0-9a-f]{64}$/) }),
    );
    expect(logger.result).toHaveBeenCalledWith({
      command: 'deposit',
      network: Network.testnet,
      amount: '10000',
      toAddress: 'ckt1receiver',
      txHash: '0xtransferhash',
    });
  });
});
