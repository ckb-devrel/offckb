import fs from 'fs';
import path from 'path';
import semver from 'semver';
import toml, { JsonMap } from '@iarna/toml';
import { isFolderExists, copyFilesWithExclusion } from '../util/fs';
import { packageRootPath, readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export interface InitChainOptions {
  // Version of the CKB binary the chain is being initialized for, when known.
  // Drives whether the Terminal RPC module (CKB >= 0.205.0) may appear in the
  // resulting ckb.toml. Null/undefined means "unknown" and keeps the
  // historical behavior of assuming support.
  ckbVersion?: string | null;
}

export async function initChainIfNeeded(options: InitChainOptions = {}) {
  const settings = readSettings();
  const devnetSourcePath = path.resolve(packageRootPath, './ckb/devnet');
  const devnetConfigPath = settings.devnet.configPath;
  const ckbTomlPath = path.join(devnetConfigPath, 'ckb.toml');
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
    // Whether the ckb.toml about to be written is the pristine bundled
    // template (as opposed to a pre-existing user file being repaired around).
    // Only a pristine template may be adapted to the CKB version below.
    const ckbTomlWasMissing = !fs.existsSync(ckbTomlPath);
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

    // The bundled template enables the Terminal RPC module, which CKB
    // versions before 0.205.0 reject at startup (serde "unknown variant").
    // Strip it from a freshly laid-down template when the binary is known to
    // be too old. A pre-existing ckb.toml is never edited here — that case is
    // reported to the user by the caller instead of silently rewritten.
    if (ckbTomlWasMissing && !supportsTerminalRpcModule(options.ckbVersion)) {
      removeTerminalRpcModule(ckbTomlPath, options.ckbVersion ?? null);
    }
  }

  migrateLegacyDevnetRpcConfig(devnetConfigPath, options.ckbVersion);
}

const TERMINAL_RPC_MODULE = 'Terminal';
const DEFAULT_TCP_LISTEN_ADDRESS = '127.0.0.1:18114';

// The Terminal RPC module (nervosnetwork/ckb#4989) first shipped in CKB
// v0.205.0. Older binaries fail config deserialization on it at startup.
export const TERMINAL_RPC_MIN_CKB_VERSION = '0.205.0';

// Unknown (null/undefined/unparseable) versions keep the historical behavior
// of assuming support — a custom binary whose version cannot be probed must
// not lose functionality it may actually have. The `-0` range suffix opts
// 0.205.0 prereleases (rc builds already carry the Terminal module) into the
// match; plain semver.gte would exclude them.
export function supportsTerminalRpcModule(ckbVersion: string | null | undefined): boolean {
  if (ckbVersion == null || !semver.valid(ckbVersion)) return true;
  return semver.satisfies(ckbVersion, `>=${TERMINAL_RPC_MIN_CKB_VERSION}-0`);
}

// Whether the chain's ckb.toml currently enables the Terminal RPC module.
// Unreadable or invalid configs report false and are left for CKB itself to
// complain about.
export function devnetConfigHasTerminalRpc(devnetConfigPath: string): boolean {
  try {
    const ckbTomlPath = path.join(devnetConfigPath, 'ckb.toml');
    if (!fs.existsSync(ckbTomlPath)) return false;
    const parsed = toml.parse(fs.readFileSync(ckbTomlPath, 'utf8'));
    const rpc = parsed.rpc as JsonMap | undefined;
    const modules = rpc?.modules;
    return (
      Array.isArray(modules) && modules.every((m) => typeof m === 'string') && modules.includes(TERMINAL_RPC_MODULE)
    );
  } catch {
    return false;
  }
}

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

// Inverse of addTerminalModule: drops "Terminal" from the rpc.modules array,
// preserving the file's formatting. Handles the single-line template layout
// and hand-formatted multi-line arrays.
function removeTerminalModule(lines: string[], section: { start: number; end: number }): boolean {
  const modulesStart = lines.findIndex(
    (line, index) => index > section.start && index < section.end && /^\s*modules\s*=\s*\[/.test(line),
  );
  if (modulesStart < 0) return false;

  if (lines[modulesStart].includes(']')) {
    const line = lines[modulesStart];
    // Terminal last (the bundled template), Terminal first, or Terminal alone.
    let updated = line.replace(/,\s*"Terminal"/, '');
    if (updated === line) updated = line.replace(/"Terminal"\s*,\s*/, '');
    if (updated === line) updated = line.replace(/\[\s*"Terminal"\s*\]/, '[]');
    if (updated === line) return false;
    lines[modulesStart] = updated;
    return true;
  }

  // Multi-line array: drop the line holding the Terminal entry.
  for (let i = modulesStart + 1; i < section.end; i++) {
    if (/^\s*"Terminal",?\s*$/.test(lines[i])) {
      lines.splice(i, 1);
      return true;
    }
    if (lines[i].includes(']')) break;
  }
  return false;
}

// Removes the Terminal RPC module from a ckb.toml known to be the bundled
// template, for CKB versions too old to support it. Text-based like the
// migration so the template's comments survive; failure is non-fatal and
// simply leaves the template as-is (CKB then reports the config error).
function removeTerminalRpcModule(ckbTomlPath: string, ckbVersion: string | null) {
  try {
    const source = fs.readFileSync(ckbTomlPath, 'utf8');
    const lines = source.split('\n');
    const section = findRpcSection(lines);
    if (section == null) return;
    if (!removeTerminalModule(lines, section)) return;

    fs.writeFileSync(ckbTomlPath, lines.join('\n'), 'utf8');
    logger.info(
      `CKB ${ckbVersion ?? '< 0.205.0'} does not support the Terminal RPC module; removed it from the new devnet ckb.toml. ` +
        `The system-metric panels of \`offckb status\` (ckb-tui) require CKB >= ${TERMINAL_RPC_MIN_CKB_VERSION}.`,
    );
  } catch (error) {
    logger.debug(`skipping Terminal RPC module removal: ${(error as Error).message}`);
  }
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
 *
 * When ckbVersion is known to predate the Terminal RPC module (< 0.205.0),
 * Terminal is NOT added — otherwise every `offckb node` start would re-add
 * what the user removed and crash the old binary at startup. The
 * tcp_listen_address half predates 0.205.0 by a wide margin and still
 * applies. Returns true when the file was changed.
 */
export function migrateLegacyDevnetRpcConfig(devnetConfigPath: string, ckbVersion?: string | null): boolean {
  const ckbTomlPath = path.join(devnetConfigPath, 'ckb.toml');
  try {
    if (!fs.existsSync(ckbTomlPath)) return false;
    const source = fs.readFileSync(ckbTomlPath, 'utf8');

    const parsed = toml.parse(source);
    const rpc = parsed.rpc as JsonMap | undefined;
    if (rpc == null || typeof rpc !== 'object') return false;

    const modules = rpc.modules;
    const needsTerminal =
      supportsTerminalRpcModule(ckbVersion) &&
      Array.isArray(modules) &&
      modules.every((m) => typeof m === 'string') &&
      !modules.includes(TERMINAL_RPC_MODULE);
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
