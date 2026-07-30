import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import toml, { JsonMap } from '@iarna/toml';
import { readSettings } from '../cfg/setting';

/**
 * Client for the CKB node's TCP JSON-RPC log subscription (the same channel
 * ckb-tui uses). The node streams every log entry it emits as a structured
 * { message, level, target, date } record, which lets the foreground node
 * show contract script debug output without relaying raw stdout.
 */

/**
 * Best-effort lookup of the devnet node's TCP subscription endpoint from its
 * ckb.toml. Consumers connect to it directly (the OffCKB proxy is HTTP-only)
 * to stream log entries; when absent, any failure here is non-fatal.
 */
export function devnetTcpListenAddress(): string | undefined {
  try {
    const settings = readSettings();
    const ckbTomlPath = path.join(settings.devnet.configPath, 'ckb.toml');
    if (!fs.existsSync(ckbTomlPath)) return undefined;
    const parsed = toml.parse(fs.readFileSync(ckbTomlPath, 'utf8'));
    const rpc = parsed.rpc as JsonMap | undefined;
    const address = rpc?.tcp_listen_address;
    if (typeof address !== 'string' || address.trim().length === 0) return undefined;
    // A wildcard bind is not a dialable address; the node runs on this host.
    return address.trim().replace(/^0\.0\.0\.0:/, '127.0.0.1:');
  } catch {
    return undefined;
  }
}

export interface CkbLogEntry {
  message: string;
  level: string;
  target: string;
  date: string;
}

export interface SubscriptionHandle {
  close(): void;
}

export interface SubscribeOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

export function parseTcpListenAddress(address: string): { host: string; port: number } | null {
  const match = address.match(/^(.+):(\d+)$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: match[1], port };
}

export function parseSubscriptionMessage(line: string): { subscriptionId?: string; entry?: CkbLogEntry } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const message = parsed as Record<string, unknown>;

  // Subscribe response: {"jsonrpc":"2.0","result":"<subscription id>","id":1}
  if (typeof message.result === 'string' && message.id !== undefined) {
    return { subscriptionId: message.result };
  }

  // Notification: {"jsonrpc":"2.0","method":"subscribe","params":{"result":{...entry},"subscription":"<id>"}}
  if (message.method === 'subscribe' && message.params != null && typeof message.params === 'object') {
    const params = message.params as Record<string, unknown>;
    const result = params.result;
    if (result != null && typeof result === 'object') {
      const entry = result as Record<string, unknown>;
      if (typeof entry.message === 'string' && typeof entry.target === 'string') {
        return {
          entry: {
            message: entry.message,
            level: typeof entry.level === 'string' ? entry.level : '',
            target: entry.target,
            date: typeof entry.date === 'string' ? entry.date : '',
          },
        };
      }
    }
  }

  return null;
}

/**
 * Subscribe to the node's "log" topic. The initial connect retries briefly
 * because the TCP listener can lag the HTTP RPC readiness check; after
 * maxAttempts the failure is reported via onError exactly once and the client
 * gives up (the full log remains available through `offckb logs -f`).
 */
export function subscribeToNodeLogs(
  tcpAddress: string,
  onEntry: (entry: CkbLogEntry) => void,
  onError?: (error: Error) => void,
  options: SubscribeOptions = {},
): SubscriptionHandle {
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const endpoint = parseTcpListenAddress(tcpAddress);

  let socket: net.Socket | null = null;
  let closed = false;
  let attempts = 0;
  let failedReported = false;
  // Retries exist only to bridge the startup window where the TCP listener
  // lags HTTP readiness; once a subscription was live, a later drop is
  // terminal here (the supervisor tears the whole service down anyway).
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const fail = (error: Error) => {
    if (failedReported || closed) return;
    failedReported = true;
    onError?.(error);
  };

  const connect = () => {
    if (closed || endpoint == null) return;
    retryTimer = null;
    attempts += 1;
    const conn = net.connect(endpoint.port, endpoint.host);
    socket = conn;
    let buffer = '';

    conn.on('connect', () => {
      everConnected = true;
      conn.write(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'subscribe', params: ['log'] }) + '\n');
    });
    conn.on('data', (data) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseSubscriptionMessage(line);
        if (parsed?.entry) onEntry(parsed.entry);
      }
    });
    conn.on('error', (error) => {
      if (closed) return;
      if (everConnected) return;
      if (attempts < maxAttempts) {
        retryTimer = setTimeout(connect, retryDelayMs);
        // A pending retry must not keep the process alive on its own.
        retryTimer.unref();
      } else {
        fail(new Error(`Log subscription to ${tcpAddress} failed after ${attempts} attempts: ${error.message}`));
      }
    });
    conn.on('close', () => {
      // The supervisor tears the whole service down when the node dies, so a
      // dropped subscription mid-run needs no reconnect of its own.
      if (socket === conn) socket = null;
    });
  };

  if (endpoint == null) {
    fail(new Error(`Log subscription address ${tcpAddress} is invalid.`));
  } else {
    connect();
  }

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      socket?.destroy();
      socket = null;
    },
  };
}
