import { startNode, stopNode } from '../src/cmd/node';
import { Network } from '../src/type/base';
import * as path from 'path';

const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
const mockOpenSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockStatSync = jest.fn();
const mockCloseSync = jest.fn();
const mockWaitForNodeReady = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  openSync: (...args: unknown[]) => mockOpenSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  closeSync: (...args: unknown[]) => mockCloseSync(...args),
}));

jest.mock('../src/tools/rpc-proxy', () => ({
  createRPCProxy: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../src/devnet/readiness', () => ({
  checkNodeReadiness: jest.fn().mockResolvedValue({ ready: false, rpcUrl: 'http://127.0.0.1:8114' }),
  waitForNodeReady: (...args: unknown[]) => mockWaitForNodeReady(...args),
}));

jest.mock('../src/cfg/setting', () => ({
  readSettings: () => ({
    devnet: {
      configPath: '/tmp/offckb-devnet-config',
      dataPath: '/tmp/offckb-devnet-data',
      rpcUrl: 'http://127.0.0.1:8114',
      rpcProxyPort: 28114,
    },
    testnet: {
      rpcUrl: 'https://testnet.ckb.dev',
      rpcProxyPort: 38114,
    },
    mainnet: {
      rpcUrl: 'https://mainnet.ckb.dev',
      rpcProxyPort: 48114,
    },
  }),
}));

jest.mock('../src/util/logger', () => ({
  logger: {
    success: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    result: jest.fn(),
    setJsonMode: jest.fn(),
  },
}));

import { logger } from '../src/util/logger';
import { fiberDaemonPaths } from '../src/fiber/paths';
import { Settings } from '../src/cfg/setting';

const dataPath = '/tmp/offckb-devnet-data';
const logDir = path.join(dataPath, 'logs');
const pidFile = path.join(logDir, 'daemon.pid');

// Format a Date the way `ps -o lstart=` prints it ("Wed Aug 13 12:36:26 2026"),
// which verifyDaemonIdentity parses for the start-time consistency check.
function formatPsLstart(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[date.getDay()]} ${months[date.getMonth()]} ${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`
  );
}

// execFile callbacks in the code under test are attached either directly or
// after an options object; normalize both arities.
function execFileCallback(optionsOrCallback: unknown, maybeCallback: unknown) {
  return (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (
    err: Error | null,
    stdout?: string,
  ) => void;
}

function mockDaemonCommandLine(scriptPath: string) {
  mockExecFile.mockImplementation(
    (file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = execFileCallback(optionsOrCallback, maybeCallback);
      if (file === 'ps') {
        if (args.includes('lstart=')) {
          callback(null, formatPsLstart(new Date()));
          return undefined as unknown as ReturnType<typeof mockExecFile>;
        }
        callback(null, `/usr/bin/node ${scriptPath} node`);
        return undefined as unknown as ReturnType<typeof mockExecFile>;
      }
      callback(null, '');
      return undefined as unknown as ReturnType<typeof mockExecFile>;
    },
  );
}

// A process whose command line is NOT our CLI: the ps lstart query still gets
// a valid answer so identity verification reaches the executable/CLI-entry
// comparison (an unparseable lstart would fail the start-time check first and
// the test would prove nothing about the command-line rules). `pidCmdline`
// may map pids to different command lines to verify one process while another
// stays foreign.
function mockUnrelatedCommandLine(pidCmdline: Record<number, string> = {}) {
  mockExecFile.mockImplementation(
    (file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = execFileCallback(optionsOrCallback, maybeCallback);
      if (file === 'ps') {
        if (args.includes('lstart=')) {
          callback(null, formatPsLstart(new Date()));
          return undefined as unknown as ReturnType<typeof mockExecFile>;
        }
        const pid = Number(args[args.indexOf('-p') + 1]);
        callback(null, pidCmdline[pid] ?? '/usr/bin/some-unrelated-process');
        return undefined as unknown as ReturnType<typeof mockExecFile>;
      }
      callback(null, '');
      return undefined as unknown as ReturnType<typeof mockExecFile>;
    },
  );
}

describe('node command daemon mode', () => {
  const originalArgv = process.argv;
  const originalPlatform = process.platform;
  let killSpy: jest.SpyInstance;

  function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', { value });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockUnlinkSync.mockReset();
    mockWaitForNodeReady.mockResolvedValue({ ready: true, rpcUrl: 'http://127.0.0.1:8114', nodeTip: 0n });
    setPlatform('linux');
    process.argv = ['node', '/path/to/offckb', 'node', '--daemon'];
    mockDaemonCommandLine(path.resolve('/path/to/offckb'));
    mockOpenSync.mockReturnValue(3);
    mockStatSync.mockReturnValue({ isFile: () => true });
    mockSpawn.mockReturnValue({
      pid: 12345,
      unref: jest.fn(),
      on: jest.fn(),
    });
    killSpy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        // By default pretend the PID from a PID file is alive; individual tests override this.
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    killSpy.mockRestore();
    setPlatform(originalPlatform);
  });

  it('spawns a detached child process without the --daemon flag', async () => {
    await startNode({ network: Network.devnet, daemon: true });

    expect(mockMkdirSync).toHaveBeenCalledWith(logDir, { recursive: true });
    const resolvedScriptPath = path.resolve('/path/to/offckb');
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [resolvedScriptPath, 'node'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 3, 3],
        env: expect.objectContaining({ OFFCKB_DAEMON_CHILD: '1' }),
      }),
    );

    const writtenMetadata = JSON.parse(mockWriteFileSync.mock.calls.at(-1)![1]);
    expect(writtenMetadata.pid).toBe(12345);
    expect(writtenMetadata.scriptPath).toBe(resolvedScriptPath);
    expect(writtenMetadata.startedAt).toBeDefined();
    expect(writtenMetadata.status).toBe('running');
    const childStatuses = mockWriteFileSync.mock.calls
      .map(([, data]) => JSON.parse(data))
      .filter((metadata) => metadata.pid === 12345)
      .map((metadata) => metadata.status);
    expect(childStatuses).toEqual(['starting', 'running']);
    expect(mockWaitForNodeReady.mock.invocationCallOrder[0]).toBeLessThan(
      mockWriteFileSync.mock.invocationCallOrder.at(-1)!,
    );

    expect(logger.success).toHaveBeenCalledWith(
      'CKB devnet daemon started with PID 12345 and passed its RPC/proxy health check.',
    );
  });

  it('warns and ignores daemon flag for non-devnet networks', async () => {
    await startNode({ network: Network.testnet, daemon: true });

    expect(logger.warn).toHaveBeenCalledWith(
      'Daemon mode is only supported for devnet. The daemon flag will be ignored.',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses to start when a daemon is already running', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 9999, scriptPath: '/path/to/offckb', startedAt: new Date().toISOString() }),
    );

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow('already running');

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('removes reused PID metadata without signaling the unrelated process', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 9999, scriptPath: '/path/to/offckb', startedAt: new Date().toISOString() }),
    );
    mockUnrelatedCommandLine();

    await startNode({ network: Network.devnet, daemon: true });

    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(killSpy).not.toHaveBeenCalledWith(-9999, expect.anything());
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('atomically refuses startup when another invocation owns the PID reservation', async () => {
    mockOpenSync.mockImplementation((file: string, flags: string) => {
      if (file === pidFile && flags === 'wx') {
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return 3;
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow(
      'startup is already in progress',
    );

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('cleans up a stale PID file and starts a new daemon', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ pid: 9999, scriptPath: '/path/to/offckb', startedAt: new Date().toISOString() }),
    );
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    await startNode({ network: Network.devnet, daemon: true });

    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('errors and cleans up when spawn fails synchronously', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn error');
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow(
      'Failed to spawn daemon process',
    );
    expect(mockCloseSync).toHaveBeenCalledWith(3);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('errors when the spawned child has no PID', async () => {
    mockSpawn.mockReturnValue({
      pid: undefined,
      unref: jest.fn(),
      on: jest.fn(),
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow('no PID returned');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('terminates the detached child when readiness checking throws', async () => {
    let processAlive = true;
    mockWaitForNodeReady.mockRejectedValueOnce(new Error('readiness check failed'));
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }
      if (signal === 'SIGTERM') processAlive = false;
      return true;
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow('readiness check failed');

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('terminates the detached child when child PID metadata cannot be written', async () => {
    let processAlive = true;
    mockWriteFileSync.mockImplementation((file: number | string, data: string) => {
      const metadata = JSON.parse(data);
      if (file === pidFile && metadata.pid === 12345) throw new Error('PID write failed');
    });
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }
      if (signal === 'SIGTERM') processAlive = false;
      return true;
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow('PID write failed');

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(mockWaitForNodeReady).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('keeps the PID reservation until failed startup termination is confirmed', async () => {
    let livenessChecks = 0;
    let livenessChecksWhenPidFileRemoved: number | undefined;
    mockUnlinkSync.mockImplementation((file: string) => {
      if (file === pidFile) livenessChecksWhenPidFileRemoved = livenessChecks;
    });
    mockWaitForNodeReady.mockResolvedValueOnce({ ready: false, error: 'proxy unavailable' });
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        livenessChecks += 1;
        if (livenessChecks >= 3) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
      }
      return true;
    });

    await expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow('proxy unavailable');

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(livenessChecks).toBeGreaterThanOrEqual(3);
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(livenessChecksWhenPidFileRemoved).toBeGreaterThanOrEqual(3);
  });

  it('escalates failed startup cleanup to SIGKILL before removing the PID file', async () => {
    jest.useFakeTimers();
    let processAlive = true;
    mockWaitForNodeReady.mockResolvedValueOnce({ ready: false, error: 'proxy unavailable' });
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }
      if (signal === 'SIGKILL') processAlive = false;
      return true;
    });

    try {
      const startupFailure = expect(startNode({ network: Network.devnet, daemon: true })).rejects.toThrow(
        'proxy unavailable',
      );
      await jest.advanceTimersByTimeAsync(5000);
      await startupFailure;

      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    } finally {
      jest.useRealTimers();
    }
  });

  it('handles backward-compatible plain PID files', async () => {
    mockReadFileSync.mockReturnValue('9999');
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    await startNode({ network: Network.devnet, daemon: true });

    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe('node command stop', () => {
  let killSpy: jest.SpyInstance;
  let processAlive = true;
  const scriptPath = '/path/to/offckb';
  const originalPlatform = process.platform;
  const originalArgv = process.argv;

  // Serve the given content only for the CKB daemon PID file; other files
  // (fiber daemon PID, fiber runtime.json) read as absent, matching a
  // machine with no fiber environment.
  function mockPidFileContent(content: string) {
    mockReadFileSync.mockImplementation((file: string) => {
      if (file === pidFile) return content;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
  }

  function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', { value });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    processAlive = true;
    mockExecFile.mockReset();
    mockStatSync.mockReturnValue({ isFile: () => true });
    mockPidFileContent(JSON.stringify({ pid: 12345, scriptPath, startedAt: new Date().toISOString() }));
    mockDaemonCommandLine(scriptPath);
    // The stop command runs from the same CLI installation as the daemon;
    // identity verification resolves our entry from argv.
    process.argv = ['node', scriptPath, 'node', 'stop'];

    // Normalize to POSIX for deterministic signal-based assertions.  The
    // implementation has a separate Windows path (taskkill) that is exercised
    // by the daemon-mode spawn tests above and by integration tests.
    setPlatform('linux');

    killSpy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (!processAlive) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        processAlive = false;
        return true;
      }
      return true;
    });
  });

  afterEach(() => {
    killSpy.mockRestore();
    setPlatform(originalPlatform);
    process.argv = originalArgv;
    jest.useRealTimers();
  });

  it('warns when no PID file exists', async () => {
    mockReadFileSync.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No daemon PID file found'));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('errors when the PID file contains an invalid PID', async () => {
    mockPidFileContent('not-a-number');
    await expect(stopNode()).rejects.toThrow('Invalid PID');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('removes the PID file when the daemon is not running', async () => {
    processAlive = false;
    await stopNode();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('does not signal the CLI process while daemon startup is in progress', async () => {
    mockPidFileContent(
      JSON.stringify({ pid: 12345, scriptPath, startedAt: new Date().toISOString(), status: 'starting' }),
    );

    await expect(stopNode()).rejects.toThrow('startup is still in progress');

    expect(killSpy).not.toHaveBeenCalledWith(-12345, expect.anything());
    expect(mockUnlinkSync).not.toHaveBeenCalledWith(pidFile);
  });

  it('stops the daemon gracefully with SIGTERM', async () => {
    await stopNode();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
    expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon stopped.');
  });

  it('falls back to SIGKILL when the daemon does not exit gracefully', async () => {
    // Simulate a process that ignores SIGTERM but dies on SIGKILL.
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      if (signal === 'SIGKILL') {
        processAlive = false;
      }
      return true;
    });

    const stopPromise = stopNode();
    await jest.advanceTimersByTimeAsync(5000);
    await stopPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  it('refuses to kill a process that does not look like the daemon', async () => {
    mockUnrelatedCommandLine();

    await expect(stopNode()).rejects.toThrow('does not appear to be the offckb daemon');

    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('preserves the PID file when SIGTERM fails with a permission error', async () => {
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    await expect(stopNode()).rejects.toThrow('Permission denied');

    expect(mockUnlinkSync).not.toHaveBeenCalledWith(pidFile);
  });

  it('preserves the PID file when process liveness cannot be checked', async () => {
    killSpy.mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    await expect(stopNode()).rejects.toThrow('Permission denied when checking daemon process');

    expect(mockUnlinkSync).not.toHaveBeenCalledWith(pidFile);
  });

  it('cleans up the PID file when the process disappears between alive-check and SIGTERM', async () => {
    killSpy.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    await stopNode();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running'));
    expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
  });

  describe('fiber daemon guard', () => {
    const fiberPidFile = fiberDaemonPaths({
      devnet: { configPath: '/tmp/offckb-devnet-config' },
    } as unknown as Settings).pidFile;
    const fiberMetadata = (pid: number) =>
      JSON.stringify({ pid, scriptPath, startedAt: new Date().toISOString(), status: 'running' });

    function mockNodeAndFiberPidFiles(fiberContent: string) {
      mockReadFileSync.mockImplementation((file: string) => {
        if (file === pidFile) {
          return JSON.stringify({ pid: 12345, scriptPath, startedAt: new Date().toISOString() });
        }
        if (file === fiberPidFile) return fiberContent;
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
    }

    it('refuses to stop while a verified fiber daemon manages FNNs, hinting at fiber stop and --force', async () => {
      mockNodeAndFiberPidFiles(fiberMetadata(23456));
      // The default mockDaemonCommandLine verifies BOTH daemons' identity.
      await expect(stopNode()).rejects.toThrow(
        'Fiber nodes are managed by a separate fiber daemon (PID 23456)',
      );
      await expect(stopNode()).rejects.toThrow('offckb node stop --force');
      expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGTERM');
    });

    it('stops the CKB daemon when the fiber daemon PID file points at an unverifiable process', async () => {
      mockNodeAndFiberPidFiles(fiberMetadata(23456));
      // PID 23456 was recycled by something foreign; the CKB daemon still verifies.
      mockUnrelatedCommandLine({ 12345: `/usr/bin/node ${scriptPath} node` });

      await stopNode();

      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      expect(mockUnlinkSync).toHaveBeenCalledWith(pidFile);
      expect(logger.success).toHaveBeenCalledWith('CKB devnet daemon stopped.');
    });

    it('warns and proceeds with --force while a verified fiber daemon is live', async () => {
      mockNodeAndFiberPidFiles(fiberMetadata(23456));

      await stopNode({ force: true });

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will keep running on a stopped chain'));
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    });
  });
});
