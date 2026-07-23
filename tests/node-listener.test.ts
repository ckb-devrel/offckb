const mockExecFileSync = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
jest.mock('../src/node/install', () => ({ installCKBBinary: jest.fn() }));
jest.mock('../src/node/init-chain', () => ({ initChainIfNeeded: jest.fn() }));
jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    bins: { defaultCKBVersion: '0.207.0' },
    devnet: {
      configPath: '/tmp/offckb-devnet',
      dataPath: '/tmp/offckb-devnet/data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
    },
  }),
  getCKBBinaryPath: () => '/tmp/ckb',
}));
jest.mock('../src/devnet/fork', () => ({ readForkState: jest.fn(), markForkFirstRunComplete: jest.fn() }));
jest.mock('../src/util/json-rpc', () => ({ callJsonRpc: jest.fn() }));
jest.mock('../src/devnet/readiness', () => ({ checkNodeReadiness: jest.fn(), waitForNodeReady: jest.fn() }));
jest.mock('../src/tools/rpc-proxy', () => ({ createRPCProxy: jest.fn() }));
jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
  },
}));

import { isProcessListeningOnPort } from '../src/cmd/node';

function lsofError(stderr: string, code?: string): Error & { stderr: Buffer; code?: string } {
  const error = new Error('lsof failed') as Error & { stderr: Buffer; code?: string };
  error.stderr = Buffer.from(stderr);
  error.code = code;
  return error;
}

describe('isProcessListeningOnPort', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when lsof finds the process listening', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('p1234'));
    expect(isProcessListeningOnPort(1234, 8114)).toBe(true);
  });

  it('returns false when lsof reports no match (empty stderr)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw lsofError('');
    });
    expect(isProcessListeningOnPort(1234, 8114)).toBe(false);
  });

  it('returns null when the lsof inspection itself failed (stderr output)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw lsofError('lsof: permission denied\n');
    });
    expect(isProcessListeningOnPort(1234, 8114)).toBeNull();
  });

  it('returns null when lsof is not installed', () => {
    mockExecFileSync.mockImplementation(() => {
      throw lsofError('spawn lsof ENOENT', 'ENOENT');
    });
    expect(isProcessListeningOnPort(1234, 8114)).toBeNull();
  });

  it('returns null when lsof hangs and hits the probe timeout', () => {
    mockExecFileSync.mockImplementation(() => {
      throw lsofError('', 'ETIMEDOUT');
    });
    expect(isProcessListeningOnPort(1234, 8114)).toBeNull();
  });

  it('bounds the lsof probe with a timeout', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('p1234'));
    isProcessListeningOnPort(1234, 8114);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'lsof',
      ['-a', '-p', '1234', '-iTCP:8114', '-sTCP:LISTEN'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});
