/**
 * The CLI installs broken-pipe handlers so `offckb ... | head` exits quietly.
 * Regression guard for the piped-Ctrl+C case: while a graceful shutdown is
 * running, an EPIPE from a dead downstream reader (Ctrl+C kills the whole
 * pipeline) must NOT exit the process — that would truncate the async fiber
 * cleanup (runtime.json left behind) and mask the 130/143 exit code.
 */

// Thrown by the mocked process.exit so a test observes "the process would
// have exited here" instead of falling through to the code after exit().
class ProcessExit extends Error {
  constructor(public readonly code?: number) {
    super(`process.exit(${code ?? 'undefined'})`);
  }
}

type ShutdownModule = typeof import('../src/util/shutdown');

function epipe(): NodeJS.ErrnoException {
  const error = new Error('write EPIPE') as NodeJS.ErrnoException;
  error.code = 'EPIPE';
  return error;
}

describe('util/shutdown broken-pipe policy', () => {
  let shutdown: ShutdownModule;
  let exitSpy: jest.SpyInstance<never, [code?: number]>;
  let stdoutListeners: unknown[];
  let stderrListeners: unknown[];

  beforeEach(() => {
    jest.resetModules();
    shutdown = require('../src/util/shutdown') as ShutdownModule;
    stdoutListeners = process.stdout.rawListeners('error');
    stderrListeners = process.stderr.rawListeners('error');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new ProcessExit(code);
      }) as (code?: number) => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const [stream, original] of [
      [process.stdout, stdoutListeners],
      [process.stderr, stderrListeners],
    ] as const) {
      for (const listener of stream.rawListeners('error')) {
        if (!original.includes(listener)) {
          stream.removeListener('error', listener as (error: Error) => void);
        }
      }
    }
  });

  it('starts outside a graceful shutdown', () => {
    expect(shutdown.isGracefulShutdownInProgress()).toBe(false);
  });

  it('exits 0 on EPIPE during normal operation (the `| head` case)', () => {
    shutdown.installBrokenPipeHandlers();
    expect(() => process.stdout.emit('error', epipe())).toThrow(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('handles stderr the same way as stdout', () => {
    shutdown.installBrokenPipeHandlers();
    expect(() => process.stderr.emit('error', epipe())).toThrow(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('swallows EPIPE once a graceful shutdown is in progress', () => {
    shutdown.installBrokenPipeHandlers();
    shutdown.enterGracefulShutdown();
    expect(shutdown.isGracefulShutdownInProgress()).toBe(true);
    // Repeated writes to the dead pipe keep erroring; none may exit.
    expect(() => process.stdout.emit('error', epipe())).not.toThrow();
    expect(() => process.stderr.emit('error', epipe())).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still rethrows non-EPIPE stream errors during a shutdown', () => {
    shutdown.installBrokenPipeHandlers();
    shutdown.enterGracefulShutdown();
    const error = new Error('some other stream failure');
    expect(() => process.stdout.emit('error', error)).toThrow(error);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
