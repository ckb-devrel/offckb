import { ChildProcess } from 'child_process';

// Conventional 128 + signal number exit codes.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
export type LifetimeSignal = keyof typeof SIGNAL_EXIT_CODES;
export const LIFETIME_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as LifetimeSignal[];

export function signalExitCode(signal: LifetimeSignal): number {
  return SIGNAL_EXIT_CODES[signal];
}

export interface ChildLifetimeGuard {
  track(child: ChildProcess): void;
  /** SIGTERM every tracked child that is still running. */
  stopAll(): void;
  /** Remove the exit hook. Does not signal the children; call stopAll() first if needed. */
  dispose(): void;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null;
}

/**
 * Tie tracked child processes to the lifetime of this offckb process.
 *
 * Children spawned without `detached` are NOT stopped when their parent dies:
 * a crash or a `process.exit()` (e.g. the broken-pipe handler) leaves them
 * running, re-parented to init/launchd. For `ckb miner` that means polling a
 * dead RPC forever (#512).
 *
 * The guard installs a process 'exit' hook — it runs on process.exit, a
 * natural end, an uncaught exception and an unhandled rejection — that sends
 * SIGTERM to every tracked child still running. It deliberately does not
 * touch signal handling: a signal only reaches this hook if its handler
 * exits the process, so the command that spawns the children must own
 * SIGINT/SIGTERM/SIGHUP explicitly (see cmd/node.ts).
 *
 * An uncatchable SIGKILL cannot be handled here; stale miners left by one are
 * reaped on the next start (see devnet/stale-miner.ts).
 */
export function bindChildrenToProcessLifetime(): ChildLifetimeGuard {
  const children = new Set<ChildProcess>();
  const stopAll = () => {
    for (const child of children) {
      if (!isRunning(child)) continue;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  };
  process.on('exit', stopAll);

  return {
    track(child) {
      children.add(child);
    },
    stopAll,
    dispose() {
      process.removeListener('exit', stopAll);
    },
  };
}
