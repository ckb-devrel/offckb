import {
  LOG_TARGETS,
  LogTarget,
  SCRIPT_LOG_TARGET,
  filterLinesByTarget,
  followLogFile,
  grepLines,
  parseCkbLogLine,
  readLogTail,
  resolveLogPath,
} from '../devnet/log-file';
import { readSettings, Settings } from '../cfg/setting';
import { logger as defaultLogger, UnifiedLogger } from '../util/logger';

export interface LogsOptions {
  follow?: boolean;
  grep?: string;
  tail?: number;
}

const DEFAULT_TAIL = 100;
// Script entries are sparse in run.log (a devnet node writes many non-script
// lines per second), so a script-filtered tail scans a much wider window and
// trims back to `tail` after filtering.
const SCRIPT_SCAN_FACTOR = 100;

/**
 * Print (and optionally follow) a devnet log file. The core is synchronous so
 * it can be unit tested with temp files; --follow hands control to
 * followLogFile and keeps the process alive until Ctrl-C.
 */
export function showLogs(target: LogTarget, options: LogsOptions, settings: Settings, logger: UnifiedLogger): void {
  const filePath = resolveLogPath(target, settings);
  const tail = options.tail ?? DEFAULT_TAIL;
  // A zero tail is rejected, not "print nothing": slice(-0) is slice(0), so
  // script mode would otherwise dump every filtered line it scanned.
  if (!Number.isInteger(tail) || tail <= 0) {
    throw new Error(`--tail must be a positive integer (got ${options.tail})`);
  }
  const scriptOnly = target === 'script';

  const scanWindow = scriptOnly ? tail * SCRIPT_SCAN_FACTOR : tail;
  let lines = readLogTail(filePath, scanWindow);
  if (scriptOnly) lines = filterLinesByTarget(lines, SCRIPT_LOG_TARGET).slice(-tail);
  if (options.grep) lines = grepLines(lines, options.grep);
  for (const line of lines) logger.info(line);

  if (!options.follow) return;

  let inScriptEntry = false;
  followLogFile(filePath, (line) => {
    let show = true;
    if (scriptOnly) {
      // Unparsable lines are continuations of the previous entry.
      const parsed = parseCkbLogLine(line);
      if (parsed) inScriptEntry = parsed.target === SCRIPT_LOG_TARGET;
      show = inScriptEntry;
    }
    if (show && options.grep && !line.includes(options.grep)) show = false;
    if (show) logger.info(line);
  });
}

export function logsCommand(target: string | undefined, options: LogsOptions): void {
  if (target != null && !LOG_TARGETS.includes(target as LogTarget)) {
    throw new Error(`Unknown log target '${target}'. Use one of: ${LOG_TARGETS.join(', ')}.`);
  }
  const resolved: LogTarget = (target as LogTarget) ?? 'node';
  showLogs(resolved, options, readSettings(), defaultLogger);
}
