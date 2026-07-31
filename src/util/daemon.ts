import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface PidMetadata {
  pid: number;
  scriptPath: string;
  startedAt: string;
  status?: 'starting' | 'running';
}

export function readPidFile(pidFile: string): PidMetadata | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    // Treat a missing or unreadable PID file as "no daemon".
    return null;
  }

  if (!raw) {
    return null;
  }

  // Backward compatibility: plain integer PID written by older versions.
  const plainPid = Number(raw);
  if (Number.isInteger(plainPid) && plainPid > 0) {
    return { pid: plainPid, scriptPath: resolveCliEntry() ?? '', startedAt: new Date(0).toISOString() };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PidMetadata>;
    const pid = Number(parsed.pid);
    if (Number.isInteger(pid) && pid > 0 && typeof parsed.scriptPath === 'string') {
      return {
        pid,
        scriptPath: parsed.scriptPath,
        startedAt: parsed.startedAt ?? new Date(0).toISOString(),
        status: parsed.status,
      };
    }
  } catch {
    // fall through to sentinel below
  }

  // Content exists but is neither a valid plain PID nor valid metadata.
  // Return a sentinel so stop commands can report an invalid PID and clean up.
  return { pid: NaN, scriptPath: '', startedAt: new Date(0).toISOString() };
}

export function writePidFile(pidFile: string, metadata: PidMetadata) {
  fs.writeFileSync(pidFile, JSON.stringify(metadata, null, 2));
}

export function reservePidFile(pidFile: string, scriptPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(pidFile, 'wx');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error('A daemon startup is already in progress. Try again after it completes.');
    }
    throw new Error(`Failed to reserve daemon PID file ${pidFile}: ${err.message}`);
  }

  let writeError: Error | undefined;
  try {
    const reservation: PidMetadata = {
      pid: process.pid,
      scriptPath,
      startedAt: new Date().toISOString(),
      status: 'starting',
    };
    fs.writeFileSync(fd, JSON.stringify(reservation, null, 2));
  } catch (error) {
    writeError = error as Error;
  } finally {
    fs.closeSync(fd);
  }
  if (writeError) {
    cleanupPidFile(pidFile);
    throw new Error(`Failed to initialize daemon PID reservation ${pidFile}: ${writeError.message}`);
  }
}

export function resolveCliEntry(): string | null {
  // In priority order. process.argv[1] is the most reliable for a Node CLI.
  // OFFCKB_CLI_PATH is an escape hatch for packaged/npx/weird environments.
  // require.main?.filename is a final fallback when argv is unavailable.
  const candidates = [process.env.OFFCKB_CLI_PATH, process.argv[1], require.main?.filename].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      const stats = fs.statSync(resolved);
      if (stats.isFile()) {
        return resolved;
      }
    } catch {
      // Candidate is missing or not a file; try the next one.
    }
  }

  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') throw new Error(`Permission denied when checking daemon process ${pid}.`);
    throw error;
  }
}

export function cleanupPidFile(pidFile: string) {
  try {
    fs.unlinkSync(pidFile);
  } catch (error) {
    // Already gone (e.g. the manager removed it before the stopper could) is
    // the goal state, not a problem.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn(`Failed to remove PID file:`, error);
  }
}

export function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (!isProcessAlive(pid)) {
          resolve(true);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

export function getProcessCommandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    // Argument arrays, never an interpolated shell string: even though pid is
    // validated as a positive integer on every path here, execFile keeps that
    // true after any future refactor.
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32'
        ? ['wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/format:list']]
        : ['ps', ['-p', String(pid), '-o', 'args=']];
    execFile(cmd, args, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      if (process.platform === 'win32') {
        const match = stdout.match(/CommandLine=(.+)/);
        resolve(match ? match[1].trim() : null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function verifyDaemonIdentity(pid: number, metadata: PidMetadata): Promise<boolean> {
  const cmdline = await getProcessCommandLine(pid);
  if (!cmdline) {
    return false;
  }

  // The daemon child re-runs the same CLI entry point, so its command line
  // should reference the same script and should be a Node process.
  const scriptName = path.basename(metadata.scriptPath);
  const scriptDir = path.dirname(metadata.scriptPath);
  const looksLikeNode = cmdline.includes('node') || cmdline.includes('nodejs');
  const looksLikeOurScript =
    cmdline.includes(metadata.scriptPath) || (scriptName !== '' && cmdline.includes(scriptName));
  const looksLikeOffckb = cmdline.includes('offckb') || scriptDir.includes('offckb');

  return looksLikeNode && (looksLikeOurScript || looksLikeOffckb);
}

export function terminateProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows has no POSIX signals and process.kill(pid) only terminates the
      // single process. Use taskkill to terminate the whole tree.
      // /T kills the process and all child processes.
      // /F forces termination when SIGKILL is requested.
      const args = signal === 'SIGKILL' ? ['/T', '/F', '/PID', String(pid)] : ['/T', '/PID', String(pid)];
      const taskkill = spawn('taskkill', args, { stdio: 'ignore' });
      taskkill.on('error', reject);
      taskkill.on('exit', () => {
        // taskkill may return non-zero if the process is already gone, which
        // is acceptable for our purposes.
        resolve();
      });
      return;
    }

    // On POSIX, detached: true makes the child a session/process group leader.
    // A negative pid sends the signal to the entire process group, ensuring
    // the managed child processes all receive it.
    try {
      process.kill(-pid, signal);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

export function closeFileDescriptors(...fds: (number | undefined)[]) {
  for (const fd of fds) {
    if (fd === undefined) continue;
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}
