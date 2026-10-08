import { EventEmitter } from 'events';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { bindChildrenToProcessLifetime } from '../src/util/child-lifetime';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = jest.fn(() => true);
}

type Listener = (...args: unknown[]) => void;

function bind() {
  const before = process.listeners('exit') as Listener[];
  const guard = bindChildrenToProcessLifetime();
  const onExit = (process.listeners('exit') as Listener[]).filter((listener) => !before.includes(listener))[0];
  return { guard, onExit };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe('bindChildrenToProcessLifetime', () => {
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

  it('stopAll signals running children without waiting for exit', () => {
    const { guard } = bind();
    const running = new FakeChild();
    guard.track(running as unknown as ChildProcess);
    guard.stopAll();
    expect(running.kill).toHaveBeenCalledWith('SIGTERM');
    guard.dispose();
  });

  it('only owns the exit hook, never signal handlers, and removes it on dispose', () => {
    const signalsBefore = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal));
    const { guard, onExit } = bind();
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))).toEqual(signalsBefore);
    guard.dispose();
    expect(process.listeners('exit')).not.toContain(onExit);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('stops a real child process from the exit hook', async () => {
    const { guard, onExit } = bind();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      guard.track(child);
      onExit(0);
      expect(await waitUntilDead(child.pid!)).toBe(true);
    } finally {
      guard.dispose();
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
  });

  describe('in a real offckb-like process', () => {
    let dir: string;

    beforeAll(() => {
      // Run the real module (no mocks, real process.exit) in a separate Node
      // process: transpile it next to a small driver script.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-child-lifetime-'));
      const source = fs.readFileSync(path.join(__dirname, '../src/util/child-lifetime.ts'), 'utf8');
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      });
      fs.writeFileSync(path.join(dir, 'child-lifetime.js'), outputText);
      fs.writeFileSync(
        path.join(dir, 'driver.js'),
        [
          "const { spawn } = require('child_process');",
          "const { bindChildrenToProcessLifetime } = require('./child-lifetime');",
          'const guard = bindChildrenToProcessLifetime();',
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          'guard.track(child);',
          "child.once('spawn', () => {",
          '  process.stdout.write(String(child.pid));',
          "  if (process.argv[2] === 'throw') setTimeout(() => { throw new Error('boom'); }, 10);",
          "  else if (process.argv[2] === 'reject') setTimeout(() => Promise.reject(new Error('boom')), 10);",
          '  else process.exit(0);',
          '});',
        ].join('\n'),
      );
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const mode of ['exit', 'throw', 'reject']) {
      posixIt(`stops the child when the parent ends via ${mode}`, async () => {
        const result = spawnSync(process.execPath, [path.join(dir, 'driver.js'), mode], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        const pid = Number(result.stdout.trim());
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        try {
          expect(await waitUntilDead(pid)).toBe(true);
        } finally {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      });
    }
  });
});
