import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { Settings } from '../cfg/setting';
import { Network } from '../type/base';

/**
 * Shared plumbing for the `offckb logs` command.
 *
 * CKB always writes its node log to `<data>/logs/run.log` and the miner log to
 * `<data>/logs/miner.log` (log_to_file = true in the bundled config), and the
 * RPC proxy appends its own events to `<data>/logs/proxy.log`. The files are
 * the one log source that exists in every run mode (foreground, daemon, and
 * while `offckb status` is attached), so the logs command is a thin reader
 * over them instead of a new logging pipeline.
 */

export type LogTarget = 'node' | 'script' | 'miner' | 'rpc';
export const LOG_TARGETS: LogTarget[] = ['node', 'script', 'miner', 'rpc'];

export interface CkbLogLine {
  timestamp: string;
  thread: string;
  level: string;
  target: string;
  message: string;
}

// 2026-07-29 11:31:27.149 +00:00 main INFO ckb_bin::subcommand::run  ckb version: ...
// The level is NOT padded and the message is separated from the target by
// whitespace (two spaces in practice; be lenient).
const CKB_LOG_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [+-]\d{2}:\d{2}) (\S+) ([A-Z]+) (\S+)\s+(.*)$/;

export const SCRIPT_LOG_TARGET = 'ckb-script';

export function parseCkbLogLine(line: string): CkbLogLine | null {
  const match = line.match(CKB_LOG_LINE);
  if (!match) return null;
  return { timestamp: match[1], thread: match[2], level: match[3], target: match[4], message: match[5] };
}

/**
 * Keep lines emitted by the given CKB log target. A line that does not parse
 * (stack traces, multi-line contract debug output) belongs to the entry above
 * it, so it is kept only when the preceding entry matched.
 */
export function filterLinesByTarget(lines: string[], target: string): string[] {
  const kept: string[] = [];
  let previousKept = false;
  for (const line of lines) {
    const parsed = parseCkbLogLine(line);
    if (parsed) {
      previousKept = parsed.target === target;
      if (previousKept) kept.push(line);
    } else if (previousKept) {
      kept.push(line);
    }
  }
  return kept;
}

export function tailLines(content: string, count: number): string[] {
  const lines = content.split('\n');
  // A trailing newline produces a final empty element that is not a log line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return count >= lines.length ? lines : lines.slice(lines.length - count);
}

export function grepLines(lines: string[], pattern: string): string[] {
  return lines.filter((line) => line.includes(pattern));
}

const LOG_FILE_NAMES: Record<Exclude<LogTarget, 'rpc'>, string> = {
  node: 'run.log',
  script: 'run.log',
  miner: 'miner.log',
};

/**
 * The proxy's event log. Derived from the per-network transactions path
 * (`<root>/<network>/transactions`) so every network lands in its own data
 * folder; for devnet this is `<devnet data>/logs/proxy.log`, next to run.log.
 */
export function proxyLogPathForNetwork(network: Network, settings: Settings): string {
  return path.resolve(settings[network].transactionsPath, '..', 'data', 'logs', 'proxy.log');
}

export function resolveLogPath(target: LogTarget, settings: Settings): string {
  if (target === 'rpc') return proxyLogPathForNetwork(Network.devnet, settings);
  return path.join(settings.devnet.dataPath, 'logs', LOG_FILE_NAMES[target]);
}

export function readLogTail(filePath: string, count: number): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(
        `Log file not found at ${filePath}. Start the devnet first (offckb node) and make sure ` +
          'ckb.toml keeps log_to_file = true.',
      );
    }
    throw error;
  }
  return tailLines(content, count);
}

/**
 * Stream appended lines from a log file, `tail -f` style. Starts at the
 * current end of file; reopen from offset 0 when the file is truncated or
 * rotated away. Polling (fs.watchFile) is used instead of fs.watch because it
 * behaves consistently across platforms and network filesystems. Returns a
 * stop function.
 */
export function followLogFile(filePath: string, onLine: (line: string) => void, intervalMs = 250): () => void {
  let offset = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  let partial = '';
  // Streaming decoder: a multi-byte UTF-8 character split across two reads
  // must not decode into replacement characters.
  let decoder = new TextDecoder('utf-8');

  const onChange = (curr: fs.Stats, prev: fs.Stats) => {
    if (curr.size < prev.size || curr.size < offset) {
      // Truncated or rotated: restart from the beginning.
      offset = 0;
      partial = '';
      decoder = new TextDecoder('utf-8');
    }
    if (curr.size === offset) return;

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return; // briefly missing during rotation; next tick retries
    }
    try {
      const length = curr.size - offset;
      const buffer = Buffer.alloc(length);
      // readSync may return fewer bytes than requested; only decode what was
      // actually read and leave the rest for the next tick.
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      offset += bytesRead;
      const text = partial + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) onLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  fs.watchFile(filePath, { interval: intervalMs }, onChange);
  return () => fs.unwatchFile(filePath, onChange);
}
