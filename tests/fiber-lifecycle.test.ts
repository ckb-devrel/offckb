import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSettings, Settings } from '../src/cfg/setting';
import {
  isProcessAlive,
  PidMetadata,
  verifyDaemonIdentity,
  writePidFile,
} from '../src/util/daemon';
import { isStoreLockHeld } from '../src/fiber/store-lock';
import { assertFiberFullyStopped } from '../src/fiber/clean';
import { startFiberEnvironment, stopFiberNodes, FnnProcessHandle } from '../src/fiber/manager';
import { fiberDaemonPaths, fiberNodePaths, fiberRootPath, runtimeJsonPath } from '../src/fiber/paths';
import { writeRuntime, isRuntimeStale, FiberRuntime } from '../src/fiber/runtime';
import { assertNodeStopDoesNotOrphanFiber, stopFiber } from '../src/fiber/daemon';
import { fiberClean } from '../src/fiber/clean';
import { FiberChainScripts } from '../src/fiber/scripts';

/**
 * Safety-property tests for the fiber lifecycle layer: daemon identity
 * verification (fail-closed), store-lock inspection states, clean's
 * fully-stopped assertion and stop's SIGTERM→SIGKILL escalation.
 */

// These tests spawn real processes; the Windows identity path shells out to
// PowerShell CIM, which needs a cold-start second or two per probe.
jest.setTimeout(30000);

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  while (children.length) {
    const child = children.pop() as ChildProcess;
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  }
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-lifecycle-'));
  tempRoots.push(root);
  return root;
}

function makeSettings(root: string): Settings {
  const settings = JSON.parse(JSON.stringify(defaultSettings)) as Settings;
  settings.devnet.configPath = path.join(root, 'devnet');
  settings.devnet.rpcUrl = 'http://127.0.0.1:8114';
  return settings;
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

// A node process running the given script file, staying alive until killed.
function spawnScriptProcess(scriptFile: string): ChildProcess {
  fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
  fs.writeFileSync(scriptFile, 'setInterval(() => {}, 1000);\n');
  return track(spawn(process.execPath, [scriptFile], { stdio: 'ignore' }));
}

// A live process whose executable is NOT node, with a command line full of
// "node" substrings (the old substring heuristic matched exactly this).
function spawnNonNodeProcess(dir: string): ChildProcess {
  const script = path.join(dir, 'node_modules-like', 'runner.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '#!/bin/sh\nsleep 60\n');
  fs.chmodSync(script, 0o755);
  return track(spawn(script, [], { stdio: 'ignore' }));
}

function pidMetadata(pid: number, overrides: Partial<PidMetadata> = {}): PidMetadata {
  return {
    pid,
    scriptPath: overrides.scriptPath ?? '',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    status: overrides.status,
  };
}

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describe('verifyDaemonIdentity', () => {
  const savedCliPath = process.env.OFFCKB_CLI_PATH;
  let cliEntry: string;

  beforeEach(() => {
    // Pin our CLI entry to a real file so resolveCliEntry is deterministic.
    cliEntry = path.join(tempRoot(), 'offckb', 'build', 'index.js');
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
    fs.writeFileSync(cliEntry, '// offckb CLI entry stub\n');
    process.env.OFFCKB_CLI_PATH = cliEntry;
  });

  afterEach(() => {
    if (savedCliPath === undefined) {
      delete process.env.OFFCKB_CLI_PATH;
    } else {
      process.env.OFFCKB_CLI_PATH = savedCliPath;
    }
  });

  it('accepts a live process running this CLI entry with a matching start time', async () => {
    const child = spawnScriptProcess(cliEntry);
    expect(await verifyDaemonIdentity(child.pid as number, pidMetadata(child.pid as number))).toBe(true);
  });

  it('rejects a node process when the pid file scriptPath merely contains "offckb"', async () => {
    // The J1 exploit shape: a forged pid file claiming an offckb-looking
    // scriptPath, pointing at an unrelated node process.
    const victim = spawnScriptProcess(path.join(tempRoot(), 'other', 'victim.js'));
    const forged = pidMetadata(victim.pid as number, {
      scriptPath: path.join(tempRoot(), 'offckb-fake', 'index.js'),
    });
    expect(await verifyDaemonIdentity(victim.pid as number, forged)).toBe(false);
  });

  it('rejects a node process whose script only shares our entry basename (index.js)', async () => {
    const foreign = spawnScriptProcess(path.join(tempRoot(), 'attacker', 'index.js'));
    const metadata = pidMetadata(foreign.pid as number, { scriptPath: cliEntry });
    expect(await verifyDaemonIdentity(foreign.pid as number, metadata)).toBe(false);
  });

  it('rejects when the pid file start time does not match the process start time (PID reuse)', async () => {
    const child = spawnScriptProcess(cliEntry);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const metadata = pidMetadata(child.pid as number, { scriptPath: cliEntry, startedAt: oneHourAgo });
    expect(await verifyDaemonIdentity(child.pid as number, metadata)).toBe(false);
  });

  it('rejects a dead pid', async () => {
    expect(await verifyDaemonIdentity(99999999, pidMetadata(99999999, { scriptPath: cliEntry }))).toBe(false);
  });

  it('accepts a legacy plain-pid record (no real startedAt) on script match alone', async () => {
    const child = spawnScriptProcess(cliEntry);
    const legacy = pidMetadata(child.pid as number, {
      scriptPath: cliEntry,
      startedAt: new Date(0).toISOString(),
    });
    expect(await verifyDaemonIdentity(child.pid as number, legacy)).toBe(true);
  });

  describePosix('non-node executables', () => {
    it('rejects a non-node process even with "node" substrings in its command line', async () => {
      const foreign = spawnNonNodeProcess(tempRoot());
      const metadata = pidMetadata(foreign.pid as number, { scriptPath: cliEntry });
      expect(await verifyDaemonIdentity(foreign.pid as number, metadata)).toBe(false);
    });
  });
});

describe('isStoreLockHeld', () => {
  it('returns false for a missing lock file', () => {
    expect(isStoreLockHeld(path.join(tempRoot(), 'LOCK'))).toBe(false);
  });

  describePosix('with lsof', () => {
    it('returns false for a lock file no process holds', () => {
      const lockFile = path.join(tempRoot(), 'LOCK');
      fs.writeFileSync(lockFile, '');
      expect(isStoreLockHeld(lockFile)).toBe(false);
    });

    it('returns true while another process holds the lock file open', async () => {
      const lockFile = path.join(tempRoot(), 'LOCK');
      fs.writeFileSync(lockFile, '');
      const holder = track(
        spawn(
          process.execPath,
          ['-e', `require('fs').openSync(${JSON.stringify(lockFile)}, 'r'); setInterval(() => {}, 1000);`],
          { stdio: 'ignore' },
        ),
      );
      // Give the holder a moment to open the file.
      let held: boolean | null = null;
      for (let i = 0; i < 50 && held !== true; i++) {
        held = isStoreLockHeld(lockFile);
        if (held !== true) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(held).toBe(true);

      holder.kill('SIGKILL');
      await once(holder, 'exit');
      expect(isStoreLockHeld(lockFile)).toBe(false);
    });

    it('returns null when lsof cannot be run (fail-closed "unknown")', () => {
      const lockFile = path.join(tempRoot(), 'LOCK');
      fs.writeFileSync(lockFile, '');
      const missingLsof = path.join(tempRoot(), 'no-such-lsof');
      expect(isStoreLockHeld(lockFile, missingLsof)).toBeNull();
    });

    it('returns null when lsof exits with an unexpected status', () => {
      const fakeLsof = path.join(tempRoot(), 'lsof');
      fs.writeFileSync(fakeLsof, '#!/bin/sh\nexit 2\n');
      fs.chmodSync(fakeLsof, 0o755);
      const lockFile = path.join(tempRoot(), 'LOCK');
      fs.writeFileSync(lockFile, '');
      expect(isStoreLockHeld(lockFile, fakeLsof)).toBeNull();
    });
  });
});

describe('isRuntimeStale', () => {
  const runtimeFor = (managerPid: number): FiberRuntime => ({
    managerPid,
    startedAt: new Date().toISOString(),
    status: 'running',
    nodes: [],
  });

  it('treats a record whose manager process is gone as stale', () => {
    expect(isRuntimeStale(runtimeFor(99999999))).toBe(true);
  });

  it('treats a record whose manager process is alive as not stale', () => {
    expect(isRuntimeStale(runtimeFor(process.pid))).toBe(false);
  });

  it('fails closed when the liveness check itself fails (EPERM) — the record is NOT stale', () => {
    // A manager we cannot inspect (owned by another user, transient /proc
    // error) may still be running; discarding its record would orphan the
    // environment. Same rule as the environment lock: unverifiable == held.
    jest.isolateModules(() => {
      jest.doMock('../src/util/daemon', () => ({
        ...jest.requireActual('../src/util/daemon'),
        isProcessAlive: () => {
          throw new Error('Permission denied when checking daemon process 1234.');
        },
      }));
      try {
        const isolated = require('../src/fiber/runtime') as typeof import('../src/fiber/runtime');
        expect(isolated.isRuntimeStale(runtimeFor(1234))).toBe(false);
      } finally {
        jest.dontMock('../src/util/daemon');
      }
    });
  });
});

describe('assertNodeStopDoesNotOrphanFiber', () => {
  const liveRuntime = (managerPid: number): FiberRuntime => ({
    managerPid,
    startedAt: new Date().toISOString(),
    status: 'running',
    nodes: [],
  });

  it('refuses to stop CKB while a live fiber environment is managed by another (foreground) process', () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(liveRuntime(process.pid), settings);
    expect(() => assertNodeStopDoesNotOrphanFiber({ ckbDaemonPid: 424242 }, settings)).toThrow(
      'offckb node stop --force',
    );
  });

  it('permits the stop when the fiber manager is the CKB daemon being stopped (node --fiber --daemon)', () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(liveRuntime(process.pid), settings);
    expect(() =>
      assertNodeStopDoesNotOrphanFiber({ ckbDaemonPid: process.pid }, settings),
    ).not.toThrow();
  });

  it('permits the stop with --force even while a foreground fiber manager is live', () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(liveRuntime(process.pid), settings);
    expect(() => assertNodeStopDoesNotOrphanFiber({ ckbDaemonPid: 424242, force: true }, settings)).not.toThrow();
  });

  it('permits the stop when no fiber runtime exists', () => {
    const settings = makeSettings(tempRoot());
    expect(() => assertNodeStopDoesNotOrphanFiber({ ckbDaemonPid: 424242 }, settings)).not.toThrow();
  });

  it('permits the stop when the recorded fiber manager is already dead (stale runtime)', () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(liveRuntime(99999999), settings);
    expect(() => assertNodeStopDoesNotOrphanFiber({ ckbDaemonPid: 424242 }, settings)).not.toThrow();
  });
});

describe('assertFiberFullyStopped', () => {
  it('refuses while a live manager runtime exists', () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(
      { managerPid: process.pid, startedAt: new Date().toISOString(), status: 'running', nodes: [] },
      settings,
    );
    expect(() => assertFiberFullyStopped(settings)).toThrow('still managed by OffCKB process');
  });

  it('refuses while a fiber daemon pid file points at a live process', () => {
    const settings = makeSettings(tempRoot());
    const { pidFile } = fiberDaemonPaths(settings);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    writePidFile(pidFile, pidMetadata(process.pid));
    expect(() => assertFiberFullyStopped(settings)).toThrow('fiber daemon is still running');
  });

  it('passes when nothing is running and no store locks exist', () => {
    const settings = makeSettings(tempRoot());
    expect(() => assertFiberFullyStopped(settings)).not.toThrow();
  });

  describePosix('store lock fail-closed behavior', () => {
    it('refuses while a store lock is held by a live process', async () => {
      const settings = makeSettings(tempRoot());
      const { storeLockFile } = fiberNodePaths(1, settings);
      fs.mkdirSync(path.dirname(storeLockFile), { recursive: true });
      fs.writeFileSync(storeLockFile, '');
      track(
        spawn(
          process.execPath,
          ['-e', `require('fs').openSync(${JSON.stringify(storeLockFile)}, 'r'); setInterval(() => {}, 1000);`],
          { stdio: 'ignore' },
        ),
      );
      // Wait until the holder is visible to lsof.
      for (let i = 0; i < 50 && isStoreLockHeld(storeLockFile) !== true; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(() => assertFiberFullyStopped(settings)).toThrow('Cannot confirm all Fiber stores are closed');
    });
  });
});

describe('stopFiber', () => {
  it('reports not-running when neither a daemon pid file nor a runtime record exists', async () => {
    const settings = makeSettings(tempRoot());
    await expect(stopFiber(settings)).resolves.toBeUndefined();
    expect(fs.existsSync(runtimeJsonPath(settings))).toBe(false);
  });

  it('discards a stale runtime record whose manager is dead, signaling nothing', async () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(
      { managerPid: 99999999, startedAt: new Date().toISOString(), status: 'running', nodes: [] },
      settings,
    );
    await stopFiber(settings);
    expect(fs.existsSync(runtimeJsonPath(settings))).toBe(false);
  });

  it('removes an unparseable daemon pid file and reports not-running', async () => {
    const settings = makeSettings(tempRoot());
    const { pidFile } = fiberDaemonPaths(settings);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, 'this is not a pid');
    await stopFiber(settings);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('refuses to signal a live daemon pid file whose identity cannot be verified', async () => {
    const settings = makeSettings(tempRoot());
    const { pidFile } = fiberDaemonPaths(settings);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    // A live process that is not this CLI: identity verification must fail
    // closed and stopFiber must refuse without sending any signal.
    const victim = spawnScriptProcess(path.join(tempRoot(), 'unrelated', 'victim.js'));
    writePidFile(pidFile, pidMetadata(victim.pid as number));
    await expect(stopFiber(settings)).rejects.toThrow('Refusing to signal');
    expect(isProcessAlive(victim.pid as number)).toBe(true);
  });
});

describe('fiberClean', () => {
  it('reports nothing-to-clean when no fiber environment exists', async () => {
    const settings = makeSettings(tempRoot());
    await expect(fiberClean({ yes: true }, settings)).resolves.toBeUndefined();
  });

  it('refuses to clean while a live manager runtime exists', async () => {
    const settings = makeSettings(tempRoot());
    fs.mkdirSync(fiberRootPath(settings), { recursive: true });
    writeRuntime(
      { managerPid: process.pid, startedAt: new Date().toISOString(), status: 'running', nodes: [] },
      settings,
    );
    await expect(fiberClean({ yes: true }, settings)).rejects.toThrow('still managed by OffCKB process');
    expect(fs.existsSync(fiberRootPath(settings))).toBe(true);
  });

  it('deletes the fiber root when everything is stopped', async () => {
    const settings = makeSettings(tempRoot());
    fs.mkdirSync(fiberNodePaths(1, settings).dir, { recursive: true });
    await fiberClean({ yes: true }, settings);
    expect(fs.existsSync(fiberRootPath(settings))).toBe(false);
  });
});

function fakeHandle(child: ChildProcess, dir: string): FnnProcessHandle {
  return { id: 1, process: child, rpcUrl: 'http://127.0.0.1:1', dir, logFile: path.join(dir, 'fnn.log') };
}

function stayAliveChild(): ChildProcess {
  return track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' }));
}

describe('stopFiberNodes', () => {
  it('stops a cooperative child with SIGTERM and removes a runtime record it owns', async () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(
      { managerPid: process.pid, startedAt: new Date().toISOString(), status: 'running', nodes: [] },
      settings,
    );
    const child = stayAliveChild();
    await stopFiberNodes([fakeHandle(child, tempRoot())], settings, 3000);
    expect(child.signalCode).toBe('SIGTERM');
    expect(fs.existsSync(runtimeJsonPath(settings))).toBe(false);
  });

  it('keeps a runtime record owned by another manager', async () => {
    const settings = makeSettings(tempRoot());
    writeRuntime(
      { managerPid: 99999999, startedAt: new Date().toISOString(), status: 'running', nodes: [] },
      settings,
    );
    await stopFiberNodes([], settings, 100);
    expect(fs.existsSync(runtimeJsonPath(settings))).toBe(true);
  });

  it('treats an already-signaled child (null exitCode, signalCode set) as exited', async () => {
    const settings = makeSettings(tempRoot());
    const child = stayAliveChild();
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGKILL');
    // Must resolve promptly instead of waiting out the grace period.
    const start = Date.now();
    await stopFiberNodes([fakeHandle(child, tempRoot())], settings, 10_000);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  describePosix('SIGKILL escalation', () => {
    it('SIGKILLs a child that ignores SIGTERM after the grace period', async () => {
      const settings = makeSettings(tempRoot());
      const child = track(
        spawn(
          process.execPath,
          // Announce readiness only after the SIGTERM handler is installed,
          // so the stop below cannot race its registration.
          ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready\\n");'],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      );
      await once(child.stdout as NodeJS.ReadableStream, 'data');
      const exited = once(child, 'exit');
      await stopFiberNodes([fakeHandle(child, tempRoot())], settings, 400);
      await exited;
      expect(child.signalCode).toBe('SIGKILL');
    }, 15000);
  });
});

describe('startFiberEnvironment signal handling', () => {
  const chainScripts: FiberChainScripts = {
    genesisHash: `0x${'11'.repeat(32)}`,
    fiberScripts: [],
    udtWhitelist: [],
  };

  function fiberFixture(): { settings: Settings; testnetConfigPath: string } {
    const root = tempRoot();
    const settings = makeSettings(root);
    const testnetConfigPath = path.join(root, 'testnet-config.yml');
    fs.writeFileSync(testnetConfigPath, 'fiber:\n  tlc_expiry_delta: 86400000\n');
    return { settings, testnetConfigPath };
  }

  it('removes its startup signal handlers after a failed start', async () => {
    const { settings, testnetConfigPath } = fiberFixture();
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');
    // process.execPath as the "FNN binary" exits immediately (node: bad option
    // -d), driving the startup down the failure path.
    await expect(
      startFiberEnvironment({
        fnnPath: process.execPath,
        testnetConfigPath,
        chainScripts,
        nodeCount: 1,
        settings,
      }),
    ).rejects.toThrow('exited during startup');
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
    // The failure path also drops the runtime record it wrote.
    expect(fs.existsSync(runtimeJsonPath(settings))).toBe(false);
  });

  describePosix('startup window', () => {
    it('SIGINT before readiness stops the spawned FNNs, drops the starting runtime and exits 130', async () => {
      const { settings, testnetConfigPath } = fiberFixture();
      // A stub FNN that stays alive but never serves RPC, so startup parks in
      // the readiness wait — the window the signal must cover.
      const stubFnn = path.join(tempRoot(), 'fnn-stub.sh');
      fs.writeFileSync(stubFnn, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"\n`);
      fs.chmodSync(stubFnn, 0o755);

      const started = startFiberEnvironment({
        fnnPath: stubFnn,
        testnetConfigPath,
        chainScripts,
        nodeCount: 1,
        settings,
      });
      // Wait for the spawn + starting runtime record.
      let fnnPid: number | null = null;
      for (let i = 0; i < 50 && fnnPid == null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const raw = JSON.parse(fs.readFileSync(runtimeJsonPath(settings), 'utf8'));
          if (raw.status === 'starting' && raw.nodes?.[0]?.pid > 0) fnnPid = raw.nodes[0].pid;
        } catch {
          // runtime not written yet
        }
      }
      expect(fnnPid).not.toBeNull();
      expect(isProcessAlive(fnnPid as number)).toBe(true);

      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
      try {
        process.emit('SIGINT');
        // Let the async cleanup run: SIGTERM the stub, drop runtime.json.
        for (let i = 0; i < 50 && exitSpy.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(exitSpy).toHaveBeenCalledWith(130);
        expect(isProcessAlive(fnnPid as number)).toBe(false);
        expect(fs.existsSync(runtimeJsonPath(settings))).toBe(false);
      } finally {
        exitSpy.mockRestore();
      }
      // The readiness wait notices the dead child and rejects.
      await expect(started).rejects.toThrow('exited during startup');
    }, 20000);
  });
});
