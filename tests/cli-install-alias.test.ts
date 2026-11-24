const mockInstallPlugin = jest.fn();

jest.mock('../src/plugins/store', () => ({
  listPlugins: jest.fn().mockReturnValue([]),
  linkPlugin: jest.fn(),
  unlinkPlugin: jest.fn(),
  getNativeBinaryPath: jest.fn().mockReturnValue('/managed/ckb-debugger/bin/ckb-debugger'),
}));
jest.mock('../src/plugins/run', () => ({ runPlugin: jest.fn() }));
jest.mock('../src/plugins/install', () => ({ installPlugin: (...args: unknown[]) => mockInstallPlugin(...args) }));
jest.mock('../src/cmd/node', () => ({ startNode: jest.fn(), stopNode: jest.fn() }));
jest.mock('../src/cmd/accounts', () => ({ accounts: jest.fn() }));
jest.mock('../src/cmd/clean', () => ({ clean: jest.fn() }));
jest.mock('../src/cmd/deposit', () => ({ deposit: jest.fn() }));
jest.mock('../src/cmd/deploy', () => ({ deploy: jest.fn() }));
jest.mock('../src/cmd/transfer', () => ({ transfer: jest.fn() }));
jest.mock('../src/cmd/balance', () => ({ balanceOf: jest.fn() }));
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
jest.mock('../src/cmd/logs', () => ({ logsCommand: jest.fn() }));
jest.mock('../src/cmd/status', () => ({ status: jest.fn() }));
jest.mock('../src/scripts/gen', () => ({ genSystemScriptsJsonFile: jest.fn() }));
jest.mock('../src/tools/ckb-debugger', () => ({ CKBDebugger: { runWithArgs: jest.fn() } }));

function loadCli() {
  jest.resetModules();
  return (require('../src/cli') as typeof import('../src/cli')).runCli;
}

// The exact-options assertions below only hold in non-interactive mode:
// a TTY-launched Jest would attach the confirmPermissions callback inside
// installPluginCommand. CI=1 pins the non-interactive branch everywhere; the
// interactive branch is covered separately at the end of this file.
const previousCI = process.env.CI;

beforeEach(() => {
  process.env.CI = '1';
  mockInstallPlugin.mockReset().mockResolvedValue({
    plugin: {
      command: 'ckb-debugger',
      name: 'ckb-debugger',
      version: '1.1.2',
      directory: '/managed/ckb-debugger',
      permissions: [],
      kind: 'binary',
    },
    source: { kind: 'catalog', id: 'ckb-debugger', requested: 'ckb-debugger', resolved: 'ckb-debugger@1.1.2' },
  });
});

afterEach(() => {
  if (previousCI === undefined) delete process.env.CI;
  else process.env.CI = previousCI;
});

it('routes `offckb install <source>` through the same installer and default options as `plugin install`', async () => {
  const runCli = loadCli();
  await runCli(['node', 'offckb', 'install', 'ckb-debugger']);
  expect(mockInstallPlugin).toHaveBeenCalledTimes(1);
  expect(mockInstallPlugin).toHaveBeenCalledWith('ckb-debugger', expect.any(Set), {
    allow: [],
    read: [],
    trust: false,
    allowScripts: false,
  });
});

it('passes install flags through exactly like `plugin install`', async () => {
  const runCli = loadCli();
  await runCli([
    'node',
    'offckb',
    'install',
    'github:foo/bar',
    '--trust',
    '--allow-scripts',
    '--allow',
    'devnet-read',
    '--read',
    '/extra',
  ]);
  expect(mockInstallPlugin).toHaveBeenCalledTimes(1);
  expect(mockInstallPlugin).toHaveBeenCalledWith('github:foo/bar', expect.any(Set), {
    allow: ['devnet-read'],
    read: ['/extra'],
    trust: true,
    allowScripts: true,
  });
});

it('emits the identical structured result from both entry points', async () => {
  const runCli = loadCli();
  const { logger } = require('../src/util/logger') as typeof import('../src/util/logger');
  const results: unknown[] = [];
  const spy = jest.spyOn(logger, 'result').mockImplementation((record) => {
    results.push(record);
  });
  try {
    await runCli(['node', 'offckb', 'install', 'ckb-debugger']);
    await runCli(['node', 'offckb', 'plugin', 'install', 'ckb-debugger']);
  } finally {
    spy.mockRestore();
  }
  expect(mockInstallPlugin).toHaveBeenCalledTimes(2);
  expect(results).toHaveLength(2);
  expect(results[1]).toEqual(results[0]);
});

describe('interactive permission consent', () => {
  const streams = [process.stdin, process.stdout, process.stderr];
  const ttyDescriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));

  beforeEach(() => {
    for (const stream of streams) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    delete process.env.CI;
  });

  afterEach(() => {
    streams.forEach((stream, index) => {
      const descriptor = ttyDescriptors[index];
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete stream.isTTY;
    });
  });

  it('attaches the consent callback through both entry points', async () => {
    const runCli = loadCli();
    await runCli(['node', 'offckb', 'install', 'ckb-debugger']);
    await runCli(['node', 'offckb', 'plugin', 'install', 'ckb-debugger']);
    expect(mockInstallPlugin).toHaveBeenCalledTimes(2);
    for (const call of mockInstallPlugin.mock.calls) {
      expect(call[2].confirmPermissions).toEqual(expect.any(Function));
    }
  });
});
