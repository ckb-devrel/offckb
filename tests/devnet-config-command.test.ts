import { devnetConfig } from '../src/cmd/devnet-config';
import { createDevnetConfigEditor } from '../src/devnet/config-editor';
import { runDevnetConfigTui } from '../src/tui/devnet-config-tui';
import { logger } from '../src/util/logger';

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: {
      configPath: '/tmp/offckb-devnet-config',
    },
  }),
}));

jest.mock('../src/devnet/config-editor', () => ({
  createDevnetConfigEditor: jest.fn(),
  InitializationError: class InitializationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'InitializationError';
    }
  },
}));

jest.mock('../src/tui/devnet-config-tui', () => ({
  runDevnetConfigTui: jest.fn(),
}));

jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe('devnet config command fallback behavior', () => {
  const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;

    (createDevnetConfigEditor as jest.Mock).mockReturnValue({
      setFieldValue: jest.fn(),
      save: jest.fn(),
    });

    (runDevnetConfigTui as jest.Mock).mockResolvedValue(false);
  });

  afterEach(() => {
    if (originalStdinTty != null) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinTty);
    }
    if (originalStdoutTty != null) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty);
    }
    process.exitCode = undefined;
  });

  it('uses --set mode in non-TTY terminals without launching TUI', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await devnetConfig({ set: ['ckb.logger.filter=info'] });

    expect(runDevnetConfigTui).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.success).toHaveBeenCalledWith('Devnet config updated at: /tmp/offckb-devnet-config');
    expect(process.exitCode).toBeUndefined();
  });

  it('throws actionable fallback guidance when TTY is unavailable', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await expect(devnetConfig()).rejects.toThrow('offckb devnet config --set ckb.logger.filter=info');

    expect(runDevnetConfigTui).not.toHaveBeenCalled();
  });
});

describe('error handling with init hint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    (createDevnetConfigEditor as jest.Mock).mockReturnValue({
      setFieldValue: jest.fn(),
      save: jest.fn(),
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('should NOT show init hint for parse errors (--set invalid)', async () => {
    await expect(devnetConfig({ set: ['invalid'] })).rejects.toThrow('Invalid --set item');
  });

  it('should NOT show init hint for unknown field errors', async () => {
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new Error("Unknown field 'unknown.field'.");
    });

    await expect(devnetConfig({ set: ['unknown.field=value'] })).rejects.toThrow('Unknown field');
  });

  it('should NOT show init hint for validation errors', async () => {
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new Error('Value must be a positive integer.');
    });

    await expect(devnetConfig({ set: ['miner.client.poll_interval=0'] })).rejects.toThrow(
      'Value must be a positive integer',
    );
  });

  it('should show init hint for missing config path (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Devnet config path does not exist: /missing/path');
    });

    await expect(devnetConfig({ set: ['ckb.logger.filter=info'] })).rejects.toThrow(
      'Devnet config path does not exist: /missing/path Tip: run `offckb node`',
    );
  });

  it('should show init hint for missing ckb.toml (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Missing file: /path/ckb.toml');
    });

    await expect(devnetConfig({ set: ['ckb.logger.filter=info'] })).rejects.toThrow(
      'Missing file: /path/ckb.toml Tip: run `offckb node`',
    );
  });

  it('should show init hint for missing miner.toml (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Missing file: /path/ckb-miner.toml');
    });

    await expect(devnetConfig({ set: ['ckb.logger.filter=info'] })).rejects.toThrow(
      'Missing file: /path/ckb-miner.toml Tip: run `offckb node`',
    );
  });
});
