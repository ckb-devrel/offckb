import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';
import { isFolderExists, copyFilesWithExclusion } from '../util/fs';
import { packageRootPath, readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export async function initChainIfNeeded() {
  const settings = readSettings();
  const devnetSourcePath = path.resolve(packageRootPath, './ckb/devnet');
  const devnetConfigPath = settings.devnet.configPath;
  const requiredConfigFiles = ['ckb.toml', 'ckb-miner.toml', path.join('specs', 'dev.toml')];
  const isInitialized =
    isFolderExists(devnetConfigPath) &&
    requiredConfigFiles.every((relativePath) => fs.existsSync(path.join(devnetConfigPath, relativePath)));
  const minerConfigPath = path.join(devnetConfigPath, 'ckb-miner.toml');
  const minerConfigWasMissing = !fs.existsSync(minerConfigPath);

  // Daemon mode creates data/logs before the child starts. A directory-only
  // check therefore mistakes a fresh install for an initialized chain. Check
  // the files CKB actually needs instead, and repair an incomplete directory.
  if (!isInitialized) {
    await copyFilesWithExclusion(devnetSourcePath, devnetConfigPath, ['data'], false);
    logger.debug(`init devnet config folder: ${devnetConfigPath}`);

    // copy and edit ckb-miner.toml
    const minerToml = path.join(devnetSourcePath, 'ckb-miner.toml');
    if (minerConfigWasMissing) {
      // Read the content of the ckb-miner.toml file
      const data = fs.readFileSync(minerToml, 'utf8');
      // Replace the URL
      const modifiedData = data.replace('http://ckb:8114/', settings.devnet.rpcUrl);
      // Write the modified content back to the file
      fs.writeFileSync(minerConfigPath, modifiedData, 'utf8');
    }
  }

  migrateLegacyDevnetRpcConfig(devnetConfigPath);
}

const TERMINAL_RPC_MODULE = 'Terminal';
const DEFAULT_TCP_LISTEN_ADDRESS = '127.0.0.1:18114';

function findRpcSection(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^\s*\[rpc\]\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]*\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Adds "Terminal" to the rpc.modules array, preserving the file's formatting.
// Handles both the single-line layout used by the bundled template and
// hand-formatted multi-line arrays.
function addTerminalModule(lines: string[], section: { start: number; end: number }): boolean {
  const modulesStart = lines.findIndex(
    (line, index) => index > section.start && index < section.end && /^\s*modules\s*=\s*\[/.test(line),
  );
  if (modulesStart < 0) return false;

  const singleLine = lines[modulesStart].match(/^(\s*modules\s*=\s*\[[^\]]*)\](\s*(?:#.*)?)$/);
  if (singleLine) {
    lines[modulesStart] = `${singleLine[1]}, "${TERMINAL_RPC_MODULE}"]${singleLine[2]}`;
    return true;
  }

  // Multi-line array: find the line holding the closing bracket, make sure the
  // previous entry ends with a comma, then insert the new module before it.
  let closingLine = -1;
  for (let i = modulesStart + 1; i < section.end; i++) {
    if (lines[i].includes(']')) {
      closingLine = i;
      break;
    }
  }
  if (closingLine < 0) return false;
  for (let i = closingLine - 1; i > modulesStart; i--) {
    if (lines[i].trim().length === 0) continue;
    if (!lines[i].trimEnd().endsWith(',')) {
      lines[i] = `${lines[i].trimEnd()},`;
    }
    break;
  }
  lines.splice(closingLine, 0, `  "${TERMINAL_RPC_MODULE}",`);
  return true;
}

// Enables rpc.tcp_listen_address. Only the stock loopback default is
// uncommented in place — a commented non-loopback value (e.g. 0.0.0.0) stays
// disabled and a fresh loopback entry is inserted after the modules array
// instead, so the migration never turns the RPC into a public listener.
function enableTcpListenAddress(lines: string[], section: { start: number; end: number }): boolean {
  for (let i = section.start + 1; i < section.end; i++) {
    const commented = lines[i].match(/^(\s*)#\s*(tcp_listen_address\s*=.*)$/);
    if (!commented) continue;
    const value = commented[2].match(/tcp_listen_address\s*=\s*"([^"]*)"/);
    if (value?.[1] === DEFAULT_TCP_LISTEN_ADDRESS) {
      lines[i] = `${commented[1]}${commented[2]}`;
      return true;
    }
  }

  let insertAt = section.start + 1;
  for (let i = section.start + 1; i < section.end; i++) {
    if (/^\s*modules\s*=\s*\[/.test(lines[i])) {
      insertAt = i + 1;
      while (insertAt < section.end && !lines[insertAt - 1].includes(']')) {
        insertAt++;
      }
      break;
    }
  }
  lines.splice(insertAt, 0, `tcp_listen_address = "${DEFAULT_TCP_LISTEN_ADDRESS}"`);
  return true;
}

/**
 * Upgrades a pre-existing devnet ckb.toml so `offckb status` (ckb-tui) works:
 * the bundled template gained the Terminal RPC module and an enabled
 * tcp_listen_address, but initChainIfNeeded only copies the template into
 * fresh config folders, so chains initialized before that change never picked
 * it up. Edits are text-based to keep user comments/formatting intact, and
 * any failure is non-fatal — node startup must never break over a migration.
 * Returns true when the file was changed.
 */
export function migrateLegacyDevnetRpcConfig(devnetConfigPath: string): boolean {
  const ckbTomlPath = path.join(devnetConfigPath, 'ckb.toml');
  try {
    if (!fs.existsSync(ckbTomlPath)) return false;
    const source = fs.readFileSync(ckbTomlPath, 'utf8');

    const parsed = toml.parse(source);
    const rpc = parsed.rpc as JsonMap | undefined;
    if (rpc == null || typeof rpc !== 'object') return false;

    const modules = rpc.modules;
    const needsTerminal =
      Array.isArray(modules) && modules.every((m) => typeof m === 'string') && !modules.includes(TERMINAL_RPC_MODULE);
    const tcpAddress = rpc.tcp_listen_address;
    const needsTcp = typeof tcpAddress !== 'string' || tcpAddress.trim().length === 0;
    if (!needsTerminal && !needsTcp) return false;

    const lines = source.split('\n');
    const section = findRpcSection(lines);
    if (section == null) return false;

    const changes: string[] = [];
    if (needsTerminal && addTerminalModule(lines, section)) {
      changes.push('Terminal RPC module');
    }
    if (needsTcp && enableTcpListenAddress(lines, findRpcSection(lines) ?? section)) {
      changes.push(`tcp_listen_address (${DEFAULT_TCP_LISTEN_ADDRESS})`);
    }
    if (changes.length === 0) return false;

    fs.writeFileSync(ckbTomlPath, lines.join('\n'), 'utf8');
    logger.info(
      `Upgraded devnet ckb.toml for ckb-tui: enabled ${changes.join(' and ')}. ` +
        'Restart the node if it is already running for this to take effect.',
    );
    return true;
  } catch (error) {
    logger.debug(`skipping devnet ckb.toml migration: ${(error as Error).message}`);
    return false;
  }
}
