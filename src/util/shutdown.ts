import process from 'node:process';

/**
 * Process-wide graceful-shutdown state shared by the CLI entry point and the
 * long-running node/fiber commands.
 *
 * Signal handlers and component-exit teardowns mark the process as shutting
 * down before they start their asynchronous cleanup, so the broken-pipe
 * policy below knows not to cut that cleanup short.
 */
let gracefulShutdownInProgress = false;

/**
 * Mark that the process has committed to a graceful shutdown (SIGINT/SIGTERM
 * or a component-exit teardown). One-way on purpose: the process exits when
 * the shutdown completes, so there is no reset.
 */
export function enterGracefulShutdown(): void {
  gracefulShutdownInProgress = true;
}

export function isGracefulShutdownInProgress(): boolean {
  return gracefulShutdownInProgress;
}

/**
 * Exit quietly when a downstream pipe closes (the standard `| head` case).
 *
 * The exception is a graceful shutdown in progress: its teardown keeps
 * logging (e.g. "Received SIGINT, stopping...") and, with piped output, the
 * reader may already be gone — Ctrl+C is delivered to the whole pipeline, so
 * `tee`/`head` exit together with the CLI. Exiting here on EPIPE would
 * truncate the async cleanup (fiber runtime.json left behind) and report the
 * wrong exit code (0 instead of 130/143). The shutdown path exits itself once
 * cleanup has finished.
 */
export function installBrokenPipeHandlers(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        if (isGracefulShutdownInProgress()) return;
        process.exit(0);
      }
      throw error;
    });
  }
}
