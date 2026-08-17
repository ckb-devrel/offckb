import { execFile, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { readSettings, Settings } from '../cfg/setting';

// Layout of the CKB devnet daemon's log/PID files under the devnet data dir.
export const NODE_DAEMON_LOG_DIR = 'logs';
export const NODE_DAEMON_LOG_FILE = 'daemon.log';
export const NODE_DAEMON_PID_FILE = 'daemon.pid';

export function nodeDaemonPaths(settings: Settings = readSettings()) {
  const logDir = path.join(settings.devnet.dataPath, NODE_DAEMON_LOG_DIR);
  return {
    logDir,
    logFile: path.join(logDir, NODE_DAEMON_LOG_FILE),
    pidFile: path.join(logDir, NODE_DAEMON_PID_FILE),
  };
}

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

export interface ProcessInfo {
  // Exact argv where the platform exposes it (Linux /proc), else null.
  argv: string[] | null;
  // Flat command line (ps / Windows CIM fallback), else null.
  cmdline: string | null;
  // Process start time as wall-clock milliseconds, or null when unavailable.
  startTimeMs: number | null;
}

// Executables allowed to host the offckb CLI entry script. Compared by exact
// basename — never by substring, which any path containing "node" would pass.
const NODE_EXECUTABLE_NAMES = new Set(['node', 'nodejs', 'node.exe']);

// How closely the live process start time must match the pid file's
// startedAt. The file is written immediately after spawn, so the true delta
// is well under a second; the generous bound only needs to catch PID reuse
// and stale pid files, and to absorb ps lstart's one-second resolution.
export const DAEMON_START_TIME_TOLERANCE_MS = 30_000;

let cachedBootTimeMs: number | null | undefined;
let cachedClockTicksPerSecond: number | undefined;

function readBootTimeMs(): number | null {
  if (cachedBootTimeMs !== undefined) return cachedBootTimeMs;
  cachedBootTimeMs = null;
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const match = stat.match(/^btime (\d+)$/m);
    if (match) cachedBootTimeMs = Number(match[1]) * 1000;
  } catch {
    // /proc unavailable — leave the cache at null.
  }
  return cachedBootTimeMs;
}

function clockTicksPerSecond(): number {
  if (cachedClockTicksPerSecond !== undefined) return cachedClockTicksPerSecond;
  cachedClockTicksPerSecond = 100; // USER_HZ on every common Linux arch
  try {
    const out = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }).trim();
    const parsed = Number(out);
    if (Number.isInteger(parsed) && parsed > 0) cachedClockTicksPerSecond = parsed;
  } catch {
    // getconf missing/failed — keep the default.
  }
  return cachedClockTicksPerSecond;
}

// /proc/<pid>/stat: the comm field (2) may itself contain spaces and ')', so
// fields are counted from the last ')'. starttime (field 22, clock ticks
// since boot) sits at index 19 of the remainder.
function readProcStartTimeMs(pid: number): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = raw.slice(closeParen + 2).split(' ');
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(startTicks) || startTicks < 0) return null;
  const bootTimeMs = readBootTimeMs();
  if (bootTimeMs == null) return null;
  return bootTimeMs + (startTicks / clockTicksPerSecond()) * 1000;
}

function readProcProcessInfo(pid: number): ProcessInfo | null {
  let rawCmdline: unknown;
  try {
    rawCmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    // Process gone, /proc not mounted, or hidden (hidepid): fall back to ps.
    return null;
  }
  if (typeof rawCmdline !== 'string') {
    return null;
  }
  const argv = rawCmdline.split('\0').filter((part) => part.length > 0);
  if (argv.length < 2) {
    // Fewer tokens than "executable + script" can never identify our daemon;
    // let the ps fallback take a second opinion (an empty cmdline also means
    // a zombie or kernel thread, which ps reports as defunct).
    return null;
  }
  return {
    argv,
    cmdline: null,
    startTimeMs: readProcStartTimeMs(pid),
  };
}

// ps lstart looks like "Wed Aug 13 12:36:26 2026" (ctime without timezone).
// Parsed manually because Date.parse of that shape is implementation-defined.
const LSTART_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parsePsLstart(text: string): number | null {
  const match = text.trim().match(/^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!match) return null;
  const month = LSTART_MONTHS[match[1]];
  if (month === undefined) return null;
  const ms = new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function execFileText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const text = stdout.trim();
      resolve(text.length > 0 ? text : null);
    });
  });
}

async function readPosixProcessInfo(pid: number): Promise<ProcessInfo> {
  const cmdline = await execFileText('ps', ['-p', String(pid), '-o', 'args=']);
  const lstart = await execFileText('ps', ['-p', String(pid), '-o', 'lstart=']);
  return { argv: null, cmdline, startTimeMs: lstart == null ? null : parsePsLstart(lstart) };
}

async function readWindowsProcessInfo(pid: number): Promise<ProcessInfo> {
  // wmic is deprecated and absent from recent Windows builds; the PowerShell
  // CIM cmdlets ship with every supported Windows version. CommandLine and
  // CreationDate are fetched in one invocation and returned as JSON.
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    'if ($null -ne $p) { ' +
    '$ms = 0; if ($null -ne $p.CreationDate) { $ms = [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }; ' +
    '@{ cmdline = $p.CommandLine; startMs = $ms } | ConvertTo-Json -Compress }';
  const text = await execFileText('powershell', ['-NoProfile', '-Command', script]);
  if (text == null) return { argv: null, cmdline: null, startTimeMs: null };
  try {
    const parsed = JSON.parse(text) as { cmdline?: unknown; startMs?: unknown };
    const cmdline = typeof parsed.cmdline === 'string' && parsed.cmdline.trim().length > 0 ? parsed.cmdline : null;
    const startMs = Number(parsed.startMs);
    return { argv: null, cmdline, startTimeMs: Number.isFinite(startMs) && startMs > 0 ? startMs : null };
  } catch {
    return { argv: null, cmdline: null, startTimeMs: null };
  }
}

/**
 * Inspect a live process. Prefers /proc on Linux (exact argv, tick-precision
 * start time) and falls back to ps when /proc is unreadable (hidepid mounts,
 * minimally configured containers). Returns null only when no source can
 * inspect the process at all; individual fields fall back to null per
 * platform.
 */
export function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(null);
  }
  if (process.platform === 'win32') {
    return readWindowsProcessInfo(pid);
  }
  if (process.platform === 'linux') {
    const procInfo = readProcProcessInfo(pid);
    if (procInfo) {
      return Promise.resolve(procInfo);
    }
  }
  return readPosixProcessInfo(pid);
}

export async function getProcessCommandLine(pid: number): Promise<string | null> {
  const info = await getProcessInfo(pid);
  if (info == null) return null;
  if (info.argv != null) return info.argv.join(' ');
  return info.cmdline;
}

// Split a flat command line into tokens, honoring single/double quotes. Used
// on platforms without /proc; the first two tokens (executable, script) are
// all the identity check consumes, and both are spawned by us without shell
// metacharacters, so a simple tokenizer suffices.
function splitCommandLine(cmdline: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cmdline)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

// Resolve symlinks on both sides before comparing (nvm shims,
// /usr/bin/node → /etc/alternatives, symlinked install prefixes). A path
// that cannot be resolved still compares by its absolute form.
function normalizePathForCompare(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function executableLooksLikeNode(executable: string): boolean {
  if (normalizePathForCompare(executable) === normalizePathForCompare(process.execPath)) {
    return true;
  }
  return NODE_EXECUTABLE_NAMES.has(path.basename(executable).toLowerCase());
}

/**
 * Whether the live process `pid` is really an offckb daemon manager. The pid
 * file is only a claim: identity comes from the live process —
 *
 *   1. its executable must be this Node runtime (exact path match against
 *      process.execPath, or an exact node/nodejs basename — no substrings);
 *   2. its first argument must be THIS installation's CLI entry script
 *      (resolveCliEntry of the verifying process, realpath-normalized) —
 *      the pid file's scriptPath is never consulted, so a stale or forged
 *      pid file cannot lend our identity to an unrelated process;
 *   3. when the pid file carries a real startedAt (everything written by
 *      current versions does), the process start time must match it, which
 *      defeats PID reuse. If the process start time cannot be determined
 *      while a recorded one exists, the check fails closed.
 *
 * Legacy plain-integer pid files carry no startedAt (epoch sentinel): they
 * pass on checks 1-2 alone.
 */
export async function verifyDaemonIdentity(pid: number, metadata: PidMetadata): Promise<boolean> {
  const cliEntry = resolveCliEntry();
  if (!cliEntry) {
    // Without our own entry point we cannot establish identity at all.
    return false;
  }
  const expectedScript = normalizePathForCompare(cliEntry);

  const info = await getProcessInfo(pid);
  if (!info) return false;

  let tokens: string[] | null = null;
  if (info.argv != null) {
    tokens = info.argv;
  } else if (info.cmdline != null) {
    tokens = splitCommandLine(info.cmdline);
  }
  if (tokens == null || tokens.length < 2) return false;

  if (!executableLooksLikeNode(tokens[0])) return false;
  if (normalizePathForCompare(tokens[1]) !== expectedScript) return false;

  const recordedMs = Date.parse(metadata.startedAt);
  if (Number.isFinite(recordedMs) && recordedMs > 0) {
    if (info.startTimeMs == null) return false;
    if (Math.abs(info.startTimeMs - recordedMs) > DAEMON_START_TIME_TOLERANCE_MS) {
      return false;
    }
  }
  return true;
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
