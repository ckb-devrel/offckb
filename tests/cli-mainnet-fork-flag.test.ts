const mockDeploy = jest.fn();
const mockTransfer = jest.fn();
const mockTransferAll = jest.fn();
const mockUdtIssue = jest.fn();
const mockUdtDestroy = jest.fn();

jest.mock('../src/cmd/node', () => ({ startNode: jest.fn(), stopNode: jest.fn() }));
jest.mock('../src/cmd/accounts', () => ({ accounts: jest.fn() }));
jest.mock('../src/cmd/clean', () => ({ clean: jest.fn() }));
jest.mock('../src/cmd/deposit', () => ({ deposit: jest.fn() }));
jest.mock('../src/cmd/deploy', () => ({ deploy: (...args: unknown[]) => mockDeploy(...args) }));
jest.mock('../src/cmd/transfer', () => ({ transfer: (...args: unknown[]) => mockTransfer(...args) }));
jest.mock('../src/cmd/balance', () => ({ balanceOf: jest.fn() }));
jest.mock('../src/cmd/udt', () => ({
  udtIssue: (...args: unknown[]) => mockUdtIssue(...args),
  udtDestroy: (...args: unknown[]) => mockUdtDestroy(...args),
}));
jest.mock('../src/cmd/create', () => ({ createScriptProject: jest.fn() }));
jest.mock('../src/cmd/config', () => ({ Config: jest.fn() }));
jest.mock('../src/cmd/devnet-config', () => ({ devnetConfig: jest.fn() }));
jest.mock('../src/cmd/devnet-fork', () => ({ devnetFork: jest.fn() }));
jest.mock('../src/cmd/devnet-info', () => ({ devnetInfo: jest.fn() }));
jest.mock('../src/cmd/debug', () => ({
  debugSingleScript: jest.fn(),
  debugTransaction: jest.fn(),
  parseSingleScriptOption: jest.fn(),
}));
jest.mock('../src/cmd/system-scripts', () => ({ printSystemScripts: jest.fn() }));
jest.mock('../src/cmd/transfer-all', () => ({ transferAll: (...args: unknown[]) => mockTransferAll(...args) }));
jest.mock('../src/cmd/status', () => ({ status: jest.fn() }));
jest.mock('../src/scripts/gen', () => ({ genSystemScriptsJsonFile: jest.fn() }));
jest.mock('../src/tools/ckb-debugger', () => ({ CKBDebugger: { runWithArgs: jest.fn() } }));
jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
    failure: jest.fn(),
    setJsonMode: jest.fn(),
    isJsonMode: jest.fn(() => false),
    hasResult: jest.fn(() => false),
  },
}));

// src/cli.ts builds its commander program at module scope and commander keeps
// parsed option values between parseAsync calls, so each test gets a fresh
// module registry to avoid option state leaking across runs.
function loadCli() {
  jest.resetModules();
  const cli = require('../src/cli') as typeof import('../src/cli');
  const { logger } = require('../src/util/logger') as typeof import('../src/util/logger');
  return { runCli: cli.runCli, logger };
}

describe('deprecated --allow-mainnet-replay-risk CLI alias', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('maps the deprecated flag onto --allow-external-key-on-mainnet-fork', async () => {
    const { runCli, logger } = loadCli();
    await runCli(['node', 'offckb', 'transfer', '0xrecipient', '100', '--allow-mainnet-replay-risk']);

    expect(mockTransfer).toHaveBeenCalledWith(
      '0xrecipient',
      '100',
      expect.objectContaining({ allowExternalKeyOnMainnetFork: true }),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('--allow-external-key-on-mainnet-fork'));
  });

  it('keeps the new flag working without a deprecation warning', async () => {
    const { runCli, logger } = loadCli();
    await runCli(['node', 'offckb', 'transfer', '0xrecipient', '100', '--allow-external-key-on-mainnet-fork']);

    expect(mockTransfer).toHaveBeenCalledWith(
      '0xrecipient',
      '100',
      expect.objectContaining({ allowExternalKeyOnMainnetFork: true }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('accepts the deprecated alias on every guarded command', async () => {
    const { runCli } = loadCli();

    await runCli(['node', 'offckb', 'deploy', '--allow-mainnet-replay-risk']);
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ allowExternalKeyOnMainnetFork: true }));

    await runCli(['node', 'offckb', 'transfer-all', '0xrecipient', '--allow-mainnet-replay-risk']);
    expect(mockTransferAll).toHaveBeenCalledWith(
      '0xrecipient',
      expect.objectContaining({ allowExternalKeyOnMainnetFork: true }),
    );

    await runCli(['node', 'offckb', 'udt', 'issue', '100', '--allow-mainnet-replay-risk']);
    expect(mockUdtIssue).toHaveBeenCalledWith('100', expect.objectContaining({ allowExternalKeyOnMainnetFork: true }));

    await runCli([
      'node',
      'offckb',
      'udt',
      'destroy',
      '100',
      '--type-args',
      '0x' + '00'.repeat(32),
      '--allow-mainnet-replay-risk',
    ]);
    expect(mockUdtDestroy).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({ allowExternalKeyOnMainnetFork: true }),
    );
  });
});
