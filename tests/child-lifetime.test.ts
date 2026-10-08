import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import { bindChildrenToProcessLifetime } from '../src/util/child-lifetime';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = jest.fn(() => true);
}

type Listener = (...args: unknown[]) => void;

function addedListeners(event: string | symbol, before: Listener[]): Listener[] {
  return (process.listeners(event as NodeJS.Signals) as Listener[]).filter((listener) => !before.includes(listener));
}

describe('bindChildrenToProcessLifetime', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  function bind() {
    const before = {
      exit: process.listeners('exit') as Listener[],
      SIGTERM: process.listeners('SIGTERM') as Listener[],
      SIGHUP: process.listeners('SIGHUP') as Listener[],
    };
    const guard = bindChildrenToProcessLifetime();
    return {
      guard,
      onExit: addedListeners('exit', before.exit)[0],
      onSigterm: addedListeners('SIGTERM', before.SIGTERM)[0],
      onSighup: addedListeners('SIGHUP', before.SIGHUP)[0],
    };
  }

  it('sends SIGTERM to running tracked children when the process exits', () => {
    const { guard, onExit } = bind();
    const running = new FakeChild();
    const exited = new FakeChild();
    exited.exitCode = 0;
    guard.track(running as unknown as ChildProcess);
    guard.track(exited as unknown as ChildProcess);

    onExit(1);

    expect(running.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exited.kill).not.toHaveBeenCalled();
    guard.dispose();
  });

  it('turns SIGTERM/SIGHUP into an exit with 128+n so the exit hook runs', () => {
    const { guard, onSigterm, onSighup } = bind();
    onSigterm();
    expect(exitSpy).toHaveBeenLastCalledWith(143);
    onSighup();
    expect(exitSpy).toHaveBeenLastCalledWith(129);
    guard.dispose();
  });

  it('defers to another handler that owns the signal', () => {
    const { guard, onSigterm } = bind();
    const other = () => {};
    process.on('SIGTERM', other);
    try {
      onSigterm();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.removeListener('SIGTERM', other);
      guard.dispose();
    }
  });

  it('removes its listeners on dispose', () => {
    const { guard, onExit, onSigterm } = bind();
    guard.dispose();
    expect(process.listeners('exit')).not.toContain(onExit);
    expect(process.listeners('SIGTERM')).not.toContain(onSigterm);
  });
});
