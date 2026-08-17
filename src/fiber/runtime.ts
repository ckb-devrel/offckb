import * as fs from 'fs';
import * as path from 'path';
import { runtimeJsonPath } from './paths';
import { readSettings, Settings } from '../cfg/setting';
import { isProcessAlive } from '../util/daemon';
import { logger } from '../util/logger';

export interface RuntimeNodeInfo {
  id: number;
  pid: number;
  dir: string;
  rpcUrl: string;
}

export interface FiberRuntime {
  managerPid: number;
  startedAt: string;
  status: 'starting' | 'running';
  nodes: RuntimeNodeInfo[];
}

export function writeRuntime(runtime: FiberRuntime, settings: Settings = readSettings()) {
  const file = runtimeJsonPath(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2));
}

export function readRuntime(settings: Settings = readSettings()): FiberRuntime | null {
  const file = runtimeJsonPath(settings);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FiberRuntime>;
    if (!Number.isInteger(parsed.managerPid) || !Array.isArray(parsed.nodes)) return null;
    return {
      managerPid: parsed.managerPid as number,
      startedAt: String(parsed.startedAt ?? ''),
      status: parsed.status === 'running' ? 'running' : 'starting',
      nodes: (parsed.nodes as RuntimeNodeInfo[]).map((node) => ({
        id: Number(node.id),
        pid: Number(node.pid),
        dir: String(node.dir),
        rpcUrl: String(node.rpcUrl),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * A runtime record is only meaningful while its manager process exists. Once
 * the manager is confirmed gone the record is stale — no further inspection
 * of program paths, ports or versions (per the Fiber design: leftovers are
 * discarded, never used to hunt processes).
 *
 * A liveness check that cannot be performed (EPERM on a process owned by
 * another user, a transient /proc error, ...) proves nothing: the manager may
 * still be running. Fail closed — the same rule the environment lock uses —
 * and treat the record as live instead of discarding the only reference to a
 * potentially running environment. Recovery from a genuine leftover in that
 * situation is manual: confirm the manager is gone, then delete runtime.json.
 */
export function isRuntimeStale(runtime: FiberRuntime): boolean {
  try {
    return !isProcessAlive(runtime.managerPid);
  } catch {
    return false;
  }
}

export function readLiveRuntime(settings: Settings = readSettings()): FiberRuntime | null {
  const runtime = readRuntime(settings);
  if (runtime == null) return null;
  if (isRuntimeStale(runtime)) return null;
  return runtime;
}

export function removeRuntimeFile(settings: Settings = readSettings()) {
  try {
    fs.unlinkSync(runtimeJsonPath(settings));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`Failed to remove ${runtimeJsonPath(settings)}: ${(error as Error).message}`);
    }
  }
}

// Remove the runtime file only when its manager is confirmed dead — used by
// clean commands to discard records that can never be acted on again.
export function removeRuntimeFileIfStale(settings: Settings = readSettings()) {
  const runtime = readRuntime(settings);
  if (runtime != null && isRuntimeStale(runtime)) {
    removeRuntimeFile(settings);
  }
}
