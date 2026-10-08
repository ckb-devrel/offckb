import { LIFETIME_SIGNALS, LifetimeSignal, signalExitCode } from './child-lifetime';
import { enterGracefulShutdown } from './shutdown';
import { logger } from './logger';

export interface SessionSignalHandlers {
  /**
   * Hand SIGINT/SIGTERM/SIGHUP to a nested flow that installs its own
   * handlers for a known window (the Fiber startup flow). Call the returned
   * function when that window ends.
   */
  delegate(): () => void;
  /** Once the session is up: run `shutdown`, then exit with 128+n. */
  setShutdown(description: string, shutdown: (signal: LifetimeSignal) => Promise<void>): void;
  dispose(): void;
}

/**
 * The single owner of SIGINT/SIGTERM/SIGHUP for a long-running session such
 * as `offckb node`. Ownership is explicit per phase rather than inferred from
 * listener counts:
 *
 *  - startup (default): exit with 128+n right away; the child lifetime
 *    guard's 'exit' hook stops the processes spawned so far.
 *  - delegated: a nested flow with its own handlers owns the signals (it
 *    exits the process itself). A second signal still forces an exit.
 *  - running: run the session's shutdown, then exit with 128+n. A second
 *    signal while it is in progress forces an exit.
 *
 * Every phase ends the process, so a signal can never be swallowed.
 */
export function installSessionSignalHandlers(): SessionSignalHandlers {
  let delegated = false;
  let running: { description: string; shutdown: (signal: LifetimeSignal) => Promise<void> } | null = null;
  let handling = false;

  const handle = (signal: LifetimeSignal) => {
    const code = signalExitCode(signal);
    if (handling) {
      process.exit(code);
      return;
    }
    handling = true;
    if (delegated) return;
    // Set before the first log line: with piped output the reader may die
    // with this same signal, and an EPIPE must not abort the shutdown.
    enterGracefulShutdown();
    if (!running) {
      process.exit(code);
      return;
    }
    const { description, shutdown } = running;
    void (async () => {
      logger.info(`Received ${signal}, stopping ${description}...`);
      try {
        await shutdown(signal);
      } catch (error) {
        logger.error(`Cleanup after ${signal} failed: ${(error as Error).message}`);
      }
      process.exit(code);
    })();
  };

  const listeners = LIFETIME_SIGNALS.map((signal) => [signal, () => handle(signal)] as const);
  for (const [signal, listener] of listeners) process.on(signal, listener);

  return {
    delegate() {
      delegated = true;
      return () => {
        delegated = false;
        // A signal seen while delegated was handled (or is being handled) by
        // the nested flow; one more signal forces the exit.
      };
    },
    setShutdown(description, shutdown) {
      running = { description, shutdown };
    },
    dispose() {
      for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    },
  };
}
