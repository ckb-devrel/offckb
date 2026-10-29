import { ChildProcess, execFileSync, spawn } from 'child_process';
import {
  bindChildrenToProcessLifetime,
  LIFETIME_SIGNALS,
  LifetimeSignal,
  signalExitCode,
} from '../util/child-lifetime';
import { enterGracefulShutdown } from '../util/shutdown';
import { createPluginContext } from './context';
import { acquirePlugin } from './store';

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      // The group was created by this invocation; never target a stored PID.
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (process.platform === 'win32' && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && process.platform !== 'win32') throw error;
  }
}

export async function runPlugin(command: string, args: string[], json: boolean): Promise<void> {
  const lease = acquirePlugin(command);
  let context: ReturnType<typeof createPluginContext> | undefined;
  const guard = bindChildrenToProcessLifetime();
  const listeners: Array<[LifetimeSignal, () => void]> = [];
  let child: ChildProcess | undefined;
  let termination: NodeJS.Timeout | undefined;
  let requestedSignal: LifetimeSignal | undefined;
  const onExit = () => {
    if (child) signalChild(child, 'SIGKILL');
  };
  try {
    // Help is delegated without reading settings, exporting scripts or requiring a chain.
    const helpOnly = args.length === 1 && (args[0] === '--help' || args[0] === '-h');
    if (!helpOnly) context = createPluginContext(lease.plugin, json);
    const env = { ...process.env };
    delete env.OFFCKB_PLUGIN_CONTEXT;
    if (context) env.OFFCKB_PLUGIN_CONTEXT = context.file;
    child = spawn(process.execPath, [lease.plugin.entry, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env,
      shell: false,
      detached: process.platform !== 'win32',
    });
    guard.track(child);
    process.on('exit', onExit);
    for (const signal of LIFETIME_SIGNALS) {
      const listener = () => {
        enterGracefulShutdown();
        const repeated = requestedSignal !== undefined;
        requestedSignal ??= signal;
        signalChild(child!, repeated ? 'SIGKILL' : signal);
        if (!termination) {
          termination = setTimeout(() => signalChild(child!, 'SIGKILL'), 3000);
          termination.unref();
        }
      };
      listeners.push([signal, listener]);
      process.on(signal, listener);
    }
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = requestedSignal
      ? signalExitCode(requestedSignal)
      : (result.code ??
        (result.signal && LIFETIME_SIGNALS.includes(result.signal as LifetimeSignal)
          ? signalExitCode(result.signal as LifetimeSignal)
          : 1));
  } finally {
    if (termination) clearTimeout(termination);
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    process.removeListener('exit', onExit);
    if (child) signalChild(child, 'SIGKILL');
    guard.stopAll();
    guard.dispose();
    try {
      context?.dispose();
    } finally {
      lease.release();
    }
  }
}
