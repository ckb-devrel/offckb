import { execSync } from 'child_process';
import os from 'os';
import { logger } from './logger';

export function setUTF8EncodingForWindows() {
  if (os.platform() === 'win32') {
    try {
      execSync('chcp 65001');
    } catch (error: unknown) {
      logger.error('Failed to set UTF-8 encoding for Windows terminal.', (error as Error).message);
    }
  }
}

export function encodeBinPathForTerminal(path: string) {
  // some path contains space in the string
  // this fix the space in the terminal
  // Escape embedded double quotes: a path containing `"` stays a single
  // argument both through shell interpolation (execSync) and through the
  // quote-aware split in CKBDebugger.runRaw.
  return `"${path.replace(/"/g, '\\"')}"`;
}
