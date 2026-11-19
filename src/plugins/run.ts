import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import {
  bindChildrenToProcessLifetime,
  LIFETIME_SIGNALS,
  LifetimeSignal,
  signalExitCode,
} from '../util/child-lifetime';
import { enterGracefulShutdown } from '../util/shutdown';
import { createPluginContext } from './context';
import { PluginManifest, nativeBinaryFileName } from './manifest';
import { acquirePlugin, nativeToolEnv } from './store';
import { assertSandboxSupported, preparePluginExecution } from './sandbox';
import { signalPluginChild as signalChild } from './process';

/** Native tool plugins delegate straight to the managed binary: no context, no sandbox. */
async function runNativeBinary(plugin: PluginManifest, args: string[]): Promise<void> {
  const guard = bindChildrenToProcessLifetime();
  const listeners: Array<[LifetimeSignal, () => void]> = [];
  let child: ChildProcess | undefined;
  let termination: NodeJS.Timeout | undefined;
  let requestedSignal: LifetimeSignal | undefined;
  const onExit = () => {
    if (child) signalChild(child, 'SIGKILL');
  };
  try {
    child = spawn(path.join(plugin.directory, nativeBinaryFileName(plugin.binaryName!)), args, {
      stdio: 'inherit',
      // Managed binaries are addressable by sibling tools through these too.
      env: { ...process.env, ...nativeToolEnv() },
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
      child!.on('error', reject);
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
  }
}

export async function runPlugin(command: string, args: string[], json: boolean, port = 7070): Promise<void> {
  const lease = acquirePlugin(command, (mode) => {
    if (mode === 'sandbox') assertSandboxSupported();
  });
  if (lease.plugin.kind === 'binary') {
    try {
      await runNativeBinary(lease.plugin, args);
    } finally {
      lease.release();
    }
    return;
  }
  let context: ReturnType<typeof createPluginContext> | undefined;
  let execution: Awaited<ReturnType<typeof preparePluginExecution>> | undefined;
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
    execution = await preparePluginExecution(lease.plugin, context?.file, lease.readPaths, args, port, lease.mode);
    child = spawn(execution.command, execution.args, {
      stdio: 'inherit',
      cwd: execution.cwd,
      env: execution.env,
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
      // kill() can emit another error during the final cleanup attempt.
      child!.on('error', reject);
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
      execution?.dispose();
    } finally {
      try {
        context?.dispose();
      } finally {
        lease.release();
      }
    }
  }
}
