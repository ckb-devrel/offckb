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

  it('prints actionable fallback guidance when TTY is unavailable', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await devnetConfig();

    expect(runDevnetConfigTui).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Interactive devnet config editor requires a TTY terminal.');
    expect(logger.info).toHaveBeenCalledWith('Use non-interactive mode instead, e.g.:');
    expect(logger.info).toHaveBeenCalledWith('  offckb devnet config --set ckb.logger.filter=info');
    expect(process.exitCode).toBe(1);
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
    await devnetConfig({ set: ['invalid'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid --set item'));
    expect(logger.info).not.toHaveBeenCalledWith(
      'Tip: run `offckb node` once to initialize devnet config files first.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('should NOT show init hint for unknown field errors', async () => {
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new Error("Unknown field 'unknown.field'.");
    });

    await devnetConfig({ set: ['unknown.field=value'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Unknown field'));
    expect(logger.info).not.toHaveBeenCalledWith(
      'Tip: run `offckb node` once to initialize devnet config files first.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('should NOT show init hint for validation errors', async () => {
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new Error('Value must be a positive integer.');
    });

    await devnetConfig({ set: ['miner.client.poll_interval=0'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Value must be a positive integer'));
    expect(logger.info).not.toHaveBeenCalledWith(
      'Tip: run `offckb node` once to initialize devnet config files first.',
    );
    expect(process.exitCode).toBe(1);
  });

  it('should show init hint for missing config path (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Devnet config path does not exist: /missing/path');
    });

    await devnetConfig({ set: ['ckb.logger.filter=info'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Devnet config path does not exist'));
    expect(logger.info).toHaveBeenCalledWith('Tip: run `offckb node` once to initialize devnet config files first.');
    expect(process.exitCode).toBe(1);
  });

  it('should show init hint for missing ckb.toml (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Missing file: /path/ckb.toml');
    });

    await devnetConfig({ set: ['ckb.logger.filter=info'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing file'));
    expect(logger.info).toHaveBeenCalledWith('Tip: run `offckb node` once to initialize devnet config files first.');
    expect(process.exitCode).toBe(1);
  });

  it('should show init hint for missing miner.toml (InitializationError)', async () => {
    const { InitializationError } = require('../src/devnet/config-editor');
    (createDevnetConfigEditor as jest.Mock).mockImplementation(() => {
      throw new InitializationError('Missing file: /path/ckb-miner.toml');
    });

    await devnetConfig({ set: ['ckb.logger.filter=info'] });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Missing file'));
    expect(logger.info).toHaveBeenCalledWith('Tip: run `offckb node` once to initialize devnet config files first.');
    expect(process.exitCode).toBe(1);
  });
});
