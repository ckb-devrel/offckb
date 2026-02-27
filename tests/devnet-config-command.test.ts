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
