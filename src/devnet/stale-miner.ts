import { execFile } from 'child_process';
import { isProcessAlive, waitForProcessExit } from '../util/daemon';
import { logger } from '../util/logger';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  // Executable name or path (ps comm / Win32_Process Name).
  name: string;
  // Full command line.
  args: string;
}

const CKB_EXECUTABLE_NAMES = new Set(['ckb', 'ckb.exe']);
const NODE_EXECUTABLE_NAMES = new Set(['node', 'nodejs', 'node.exe']);
const LIST_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

function basename(executable: string): string {
  const parts = executable
    .trim()
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * Whether `args` is exactly the command offckb uses to start the devnet miner:
 * `<.../ckb> miner -C <configPath>`. The executable must be named `ckb` and
 * the config dir must match exactly; ps prints argv joined by spaces (paths
 * may contain spaces), Windows may quote the arguments.
 */
export function isMinerCommandFor(args: string, configPath: string): boolean {
  const trimmed = args.trim();
  for (const suffix of [` miner -C ${configPath}`, ` miner -C "${configPath}"`]) {
    if (trimmed.endsWith(suffix)) {
      return CKB_EXECUTABLE_NAMES.has(basename(trimmed.slice(0, -suffix.length)));
    }
  }
  return false;
}

/**
 * Pick the `ckb miner` processes for this devnet dir whose offckb parent is
 * gone. A live offckb session keeps its miner as a direct child of its Node
 * process; once that process dies the miner is re-parented (init, launchd or
 * a subreaper) or, on Windows, points at a dead parent PID. Miners whose
 * parent is still a Node process are left alone.
 */
export function findStaleMiners(entries: ProcessEntry[], configPath: string, selfPid = process.pid): ProcessEntry[] {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  return entries.filter((entry) => {
    if (entry.pid === selfPid || !isMinerCommandFor(entry.args, configPath)) return false;
    const parent = byPid.get(entry.ppid);
    return parent == null || !NODE_EXECUTABLE_NAMES.has(basename(parent.name));
  });
}

function execText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function listPosixProcesses(): Promise<ProcessEntry[] | null> {
  // Two passes because comm (macOS: full executable path) and args may both
  // contain spaces, so they cannot share one line unambiguously.
  const [argsOut, commOut] = await Promise.all([
    execText('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']),
    execText('ps', ['-A', '-ww', '-o', 'pid=,comm=']),
  ]);
  if (argsOut == null || commOut == null) return null;
  const names = new Map<number, string>();
  for (const line of commOut.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) names.set(Number(match[1]), match[2].trim());
  }
  const entries: ProcessEntry[] = [];
  for (const line of argsOut.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    entries.push({ pid, ppid: Number(match[2]), name: names.get(pid) ?? '', args: match[3].trim() });
  }
  return entries;
}

async function listWindowsProcesses(): Promise<ProcessEntry[] | null> {
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const text = await execText('powershell', ['-NoProfile', '-Command', script]);
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      name: typeof row.Name === 'string' ? row.Name : '',
      args: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }));
  } catch {
    return null;
  }
}

export function listProcesses(): Promise<ProcessEntry[] | null> {
  return process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
}

/**
 * Stop `ckb miner -C <configPath>` processes left behind by an earlier offckb
 * run (#512) before a new devnet starts. Best effort: a failure to list or
 * signal processes is logged and never blocks the start. Returns the PIDs
 * that were stopped.
 */
export async function reapStaleMiners(configPath: string): Promise<number[]> {
  const entries = await listProcesses();
  if (entries == null) {
    logger.debug('Could not list processes; skipping the stale CKB miner check.');
    return [];
  }
  const reaped: number[] = [];
  for (const miner of findStaleMiners(entries, configPath)) {
    logger.warn(`Stopping stale CKB miner (PID ${miner.pid}) left over from a previous offckb run.`);
    try {
      process.kill(miner.pid, 'SIGTERM');
      if (!(await waitForProcessExit(miner.pid, STOP_TIMEOUT_MS)) && isProcessAlive(miner.pid)) {
        process.kill(miner.pid, 'SIGKILL');
      }
      reaped.push(miner.pid);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') continue;
      logger.warn(`Failed to stop stale CKB miner (PID ${miner.pid}): ${err.message}`);
    }
  }
  return reaped;
}
