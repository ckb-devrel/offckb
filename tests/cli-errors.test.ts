const mockBalanceOf = jest.fn();
const mockLogsCommand = jest.fn();
const jsonMode = { value: false };

jest.mock('../src/cmd/node', () => ({ startNode: jest.fn(), stopNode: jest.fn() }));
jest.mock('../src/cmd/accounts', () => ({ accounts: jest.fn() }));
jest.mock('../src/cmd/clean', () => ({ clean: jest.fn() }));
jest.mock('../src/cmd/deposit', () => ({ deposit: jest.fn() }));
jest.mock('../src/cmd/deploy', () => ({ deploy: jest.fn() }));
jest.mock('../src/cmd/transfer', () => ({ transfer: jest.fn() }));
jest.mock('../src/cmd/balance', () => ({ balanceOf: (...args: unknown[]) => mockBalanceOf(...args) }));
jest.mock('../src/cmd/udt', () => ({ udtIssue: jest.fn(), udtDestroy: jest.fn() }));
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
jest.mock('../src/cmd/transfer-all', () => ({ transferAll: jest.fn() }));
jest.mock('../src/cmd/logs', () => ({ logsCommand: (...args: unknown[]) => mockLogsCommand(...args) }));
jest.mock('../src/cmd/status', () => ({ status: jest.fn() }));
jest.mock('../src/scripts/gen', () => ({ genSystemScriptsJsonFile: jest.fn() }));
jest.mock('../src/tools/ckb-debugger', () => ({ CKBDebugger: { runWithArgs: jest.fn() } }));

// The logger mock mirrors the real UnifiedLogger: in JSON mode failure()
// writes one structured record to stderr, otherwise it writes the plain
// message to stderr like the winston console transport does. That way the
// tests can assert each commander error reaches stderr exactly once.
const mockFailure = jest.fn((code: string, message: string) => {
  process.stderr.write(jsonMode.value ? `${JSON.stringify({ ok: false, code, message })}\n` : `${message}\n`);
});
jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
    failure: (...args: unknown[]) => mockFailure(args[0] as string, args[1] as string),
    setJsonMode: (enabled: boolean) => {
      jsonMode.value = enabled;
    },
    isJsonMode: () => jsonMode.value,
    hasResult: () => false,
  },
}));

function loadCli() {
  jest.resetModules();
  const cli = require('../src/cli') as typeof import('../src/cli');
  return { runCli: cli.runCli };
}

function captureStderr() {
  const writes: string[] = [];
  const spy = jest.spyOn(process.stderr, 'write');
  spy.mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return {
    writes,
    text: () => writes.join(''),
    count: (needle: string) => writes.filter((w) => w.includes(needle)).length,
    restore: () => spy.mockRestore(),
  };
}

describe('CLI error output', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jsonMode.value = false;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('balance without an address prints a clear missing-argument error once', async () => {
    const { runCli } = loadCli();
    const stderr = captureStderr();
    try {
      await runCli(['node', 'offckb', 'balance']);
    } finally {
      stderr.restore();
    }

    expect(stderr.count("missing required argument 'toAddress'")).toBe(1);
    expect(stderr.text()).not.toContain('Unknown address format');
    expect(mockBalanceOf).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints an unknown-option error exactly once on stderr', async () => {
    const { runCli } = loadCli();
    const stderr = captureStderr();
    try {
      await runCli(['node', 'offckb', 'balance', 'ckt1qaddress', '--unknown-flag']);
    } finally {
      stderr.restore();
    }

    expect(stderr.count("unknown option '--unknown-flag'")).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('prints an invalid option value error exactly once on stderr', async () => {
    const { runCli } = loadCli();
    const stderr = captureStderr();
    try {
      await runCli(['node', 'offckb', 'logs', '--tail', 'abc']);
    } finally {
      stderr.restore();
    }

    expect(stderr.count('--tail must be a positive integer')).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('emits a single structured record for commander errors in JSON mode', async () => {
    const { runCli } = loadCli();
    const stderr = captureStderr();
    try {
      await runCli(['node', 'offckb', '--json', 'balance']);
    } finally {
      stderr.restore();
    }

    expect(stderr.count('commander.missingArgument')).toBe(1);
    expect(stderr.text()).toContain('"ok":false');
    expect(stderr.text()).not.toContain("error: missing required argument 'toAddress'\nerror:");
    expect(process.exitCode).toBe(1);
  });

  it('still invokes balanceOf when an address is provided', async () => {
    const { runCli } = loadCli();
    await runCli(['node', 'offckb', 'balance', 'ckt1qaddress']);

    expect(mockBalanceOf).toHaveBeenCalledWith('ckt1qaddress', expect.anything());
  });
});
