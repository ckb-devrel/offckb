import { ChildProcess, execFileSync } from 'child_process';

/** Only signal the child/group owned by this invocation, never a PID from storage. */
export function signalPluginChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode != null || child.signalCode != null) return;
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill(process.platform === 'win32' ? 'SIGKILL' : signal);
    } catch {
      // Best effort: signaling failure must not bypass cleanup.
    }
  }
}
