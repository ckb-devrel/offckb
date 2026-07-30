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

/**
 * Print (and optionally follow) a devnet log file. The core is synchronous so
 * it can be unit tested with temp files; --follow hands control to
 * followLogFile and keeps the process alive until Ctrl-C.
 */
export function showLogs(target: LogTarget, options: LogsOptions, settings: Settings, logger: UnifiedLogger): void {
  const filePath = resolveLogPath(target, settings);
  const tail = options.tail ?? DEFAULT_TAIL;

  let lines = readLogTail(filePath, tail);
  const scriptOnly = target === 'script';
  if (scriptOnly) lines = filterLinesByTarget(lines, SCRIPT_LOG_TARGET);
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
  const resolved: LogTarget = LOG_TARGETS.includes(target as LogTarget) ? (target as LogTarget) : 'node';
  showLogs(resolved, options, readSettings(), defaultLogger);
}
