const mockRun = jest.fn();
const mockCheckNodeReadiness = jest.fn();

jest.mock('../src/tools/ckb-tui', () => ({ CKBTui: { run: (...args: unknown[]) => mockRun(...args) } }));
jest.mock('../src/devnet/readiness', () => ({
  checkNodeReadiness: (...args: unknown[]) => mockCheckNodeReadiness(...args),
}));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: { rpcProxyPort: 28114 },
    testnet: { rpcProxyPort: 38114 },
    mainnet: { rpcProxyPort: 48114 },
  }),
}));

import { status } from '../src/cmd/status';
import { Network } from '../src/type/base';

describe('status command', () => {
  const originalStdoutTTY = process.stdout.isTTY;
  const originalStdinTTY = process.stdin.isTTY;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  });

  afterAll(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutTTY });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinTTY });
  });

  it('launches ckb-tui only after a real JSON-RPC health check', async () => {
    mockCheckNodeReadiness.mockResolvedValue({ ready: true });
    mockRun.mockReturnValue({ status: 0 });
    await status({ network: Network.devnet });
    expect(mockCheckNodeReadiness).toHaveBeenCalledWith('http://127.0.0.1:28114');
    expect(mockRun).toHaveBeenCalledWith(['-r', 'http://127.0.0.1:28114']);
  });

  it('rejects a listening proxy whose upstream node is dead', async () => {
    mockCheckNodeReadiness.mockResolvedValue({ ready: false, error: 'upstream refused' });
    await expect(status({ network: Network.devnet })).rejects.toThrow('upstream refused');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects non-interactive use', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    await expect(status({ network: Network.devnet })).rejects.toThrow('interactive terminal');
  });

  it('turns a non-zero ckb-tui exit into a command failure', async () => {
    mockCheckNodeReadiness.mockResolvedValue({ ready: true });
    mockRun.mockReturnValue({ status: 7 });
    await expect(status({ network: Network.devnet })).rejects.toThrow('ckb-tui exited with code 7');
  });
});
