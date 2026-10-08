jest.mock('../src/util/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));

import { installSessionSignalHandlers } from '../src/util/session-signals';

type Listener = () => void;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function install() {
  const before = Object.fromEntries(SIGNALS.map((signal) => [signal, process.listeners(signal) as Listener[]]));
  const handlers = installSessionSignalHandlers();
  const emit = Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      (process.listeners(signal) as Listener[]).filter((listener) => !before[signal].includes(listener))[0],
    ]),
  ) as Record<(typeof SIGNALS)[number], Listener>;
  return { handlers, emit };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('installSessionSignalHandlers', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with 128+n during startup so the exit hook stops the children', () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const { handlers, emit } = install();
      emit[signal]();
      expect(exitSpy).toHaveBeenLastCalledWith(code);
      handlers.dispose();
    }
  });

  it('runs the session shutdown before exiting once the session is up', async () => {
    const { handlers, emit } = install();
    let release: () => void = () => {};
    const shutdown = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
    handlers.setShutdown('the devnet', shutdown);

    emit.SIGTERM();
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    await flush();
    expect(exitSpy).not.toHaveBeenCalled();

    release();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(143);
    handlers.dispose();
  });

  it('still exits when the shutdown fails', async () => {
    const { handlers, emit } = install();
    handlers.setShutdown('the devnet', () => Promise.reject(new Error('cleanup failed')));
    emit.SIGHUP();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(129);
    handlers.dispose();
  });

  it('forces the exit on a second signal while the shutdown is in progress', () => {
    const { handlers, emit } = install();
    handlers.setShutdown('the devnet', () => new Promise<void>(() => {}));
    emit.SIGINT();
    expect(exitSpy).not.toHaveBeenCalled();
    emit.SIGINT();
    expect(exitSpy).toHaveBeenCalledWith(130);
    handlers.dispose();
  });

  it('leaves the first signal to a delegated flow but never swallows a second one', () => {
    const { handlers, emit } = install();
    const endDelegation = handlers.delegate();
    emit.SIGTERM();
    expect(exitSpy).not.toHaveBeenCalled();
    emit.SIGTERM();
    expect(exitSpy).toHaveBeenCalledWith(143);
    endDelegation();
    handlers.dispose();
  });

  it('owns the signals again after the delegation ends', () => {
    const { handlers, emit } = install();
    handlers.delegate()();
    emit.SIGTERM();
    expect(exitSpy).toHaveBeenCalledWith(143);
    handlers.dispose();
  });

  it('removes its listeners on dispose', () => {
    const { handlers, emit } = install();
    handlers.dispose();
    for (const signal of SIGNALS) expect(process.listeners(signal)).not.toContain(emit[signal]);
  });
});
