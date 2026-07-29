import * as fs from 'fs';
import * as path from 'path';

/**
 * Testable core of the RPC proxy's logging behavior.
 *
 * The proxy keeps the console quiet by default (per-request lines at debug
 * level) while surfacing the two signals users actually watch for —
 * submitted transaction hashes and JSON-RPC errors — and mirrors everything
 * into `<network data>/logs/proxy.log` so `offckb logs rpc` can replay it.
 */

export interface ProxyLogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ProxyEventLog {
  filePath: string;
  event(text: string): void;
}

export interface ProxyEventContext {
  sink: ProxyLogSink;
  events: ProxyEventLog;
  transactionsPath: string;
  hashTransaction(tx: unknown): string;
}

/** Append-only writer for proxy.log. Directory creation is lazy and cached. */
export function createProxyEventLog(filePath: string): ProxyEventLog {
  let dirReady = false;
  return {
    filePath,
    event(text: string) {
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          dirReady = true;
        }
        fs.appendFileSync(filePath, `${new Date().toISOString()} ${text}\n`);
      } catch {
        // Logging must never break request forwarding.
        dirReady = false;
      }
    },
  };
}

interface JsonRpcRequestPayload {
  method?: unknown;
  params?: unknown;
}

export function handleProxyRequestBody(reqData: string, ctx: ProxyEventContext): void {
  if (reqData.length === 0) return;

  try {
    const jsonRpcContent = JSON.parse(reqData) as JsonRpcRequestPayload;
    const method = jsonRpcContent.method;
    const params = jsonRpcContent.params;
    ctx.sink.debug('RPC Req: ', method);
    if (typeof method === 'string') {
      ctx.events.event(`request ${method}`);
    }

    if (method === 'send_transaction') {
      const tx = (params as unknown[])[0];
      const txHash = ctx.hashTransaction(tx);
      if (!fs.existsSync(ctx.transactionsPath)) {
        fs.mkdirSync(ctx.transactionsPath, { recursive: true });
      }
      const txFile = path.resolve(ctx.transactionsPath, `${txHash}.json`);
      fs.writeFileSync(txFile, JSON.stringify(tx, null, 2));
      // The hash line mirrors the RPC method name on purpose: at request time
      // the proxy does not yet know whether the node will accept the tx, and
      // any rejection surfaces separately as an RPC error line.
      ctx.sink.info(`send_transaction: ${txHash}`);
      ctx.events.event(`send_transaction ${txHash}`);
    }
  } catch (err) {
    ctx.sink.error('Error parsing JSON-RPC req content:', (err as Error).message);
  }
}

interface JsonRpcErrorPayload {
  error?: { code?: unknown; message?: unknown };
}

export function handleProxyResponseBody(res: string, contentType: string | undefined, ctx: ProxyEventContext): void {
  if (res.length === 0) return;
  if (contentType !== 'application/json') return;
  if (!res.trim().startsWith('{') && !res.trim().startsWith('[')) return;

  try {
    const parsed = JSON.parse(res) as JsonRpcErrorPayload | JsonRpcErrorPayload[];
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (entry?.error == null) continue;
      const code = entry.error.code ?? 'unknown';
      const message = entry.error.message ?? 'unknown error';
      ctx.sink.warn(`RPC error: [${code}] ${message}`);
      ctx.events.event(`error [${code}] ${message}`);
    }
  } catch (err) {
    ctx.sink.error('Error parsing JSON-RPC res content:', (err as Error).message);
  }
}
