import { ChildProcess } from 'child_process';
import { enterGracefulShutdown } from './shutdown';

// Conventional 128 + signal number exit codes.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
export type LifetimeSignal = keyof typeof SIGNAL_EXIT_CODES;
const LIFETIME_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as LifetimeSignal[];

export function signalExitCode(signal: LifetimeSignal): number {
  return SIGNAL_EXIT_CODES[signal];
}

export interface ChildLifetimeGuard {
  track(child: ChildProcess): void;
  dispose(): void;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null;
}

/**
 * Tie tracked child processes to the lifetime of this offckb process.
 *
 * Children spawned without `detached` are NOT stopped when their parent dies:
 * a parent killed by a plain SIGTERM/SIGHUP (default action), a crash, or a
 * `process.exit()` (e.g. the broken-pipe handler) leaves them running,
 * re-parented to init/launchd. For `ckb miner` that means polling a dead RPC
 * forever (#512).
 *
 *  - On 'exit' (process.exit, natural end, uncaught exception or unhandled
 *    rejection) every tracked child that is still running gets SIGTERM.
 *  - SIGINT/SIGTERM/SIGHUP are turned into a process.exit(128+n) so the
 *    'exit' hook runs instead of the default "terminate without cleanup".
 *    When another handler owns the signal (the Fiber shutdown handlers),
 *    this one stays out of the way; that handler exits the process itself,
 *    which still runs the 'exit' hook.
 *
 * An uncatchable SIGKILL cannot be handled here; stale miners left by one are
 * reaped on the next start (see devnet/stale-miner.ts).
 */
export function bindChildrenToProcessLifetime(): ChildLifetimeGuard {
  const children = new Set<ChildProcess>();
  const killChildren = () => {
    for (const child of children) {
      if (!isRunning(child)) continue;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  };
  const signalListeners = LIFETIME_SIGNALS.map((signal) => {
    const listener = () => {
      if (process.listenerCount(signal) > 1) return;
      enterGracefulShutdown();
      process.exit(SIGNAL_EXIT_CODES[signal]);
    };
    return [signal, listener] as const;
  });

  process.on('exit', killChildren);
  for (const [signal, listener] of signalListeners) process.on(signal, listener);

  return {
    track(child) {
      children.add(child);
    },
    dispose() {
      process.removeListener('exit', killChildren);
      for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
    },
  };
}
