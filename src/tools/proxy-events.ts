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

/**
 * One event is exactly one line in proxy.log: RPC method names and error
 * messages come from the proxied payloads, so embedded newlines or control
 * characters would otherwise forge log records or corrupt `offckb logs rpc`
 * output. Sanitizing here covers every call site.
 */
function sanitizeEventText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** Default size cap for proxy.log; past it the file rolls over once to .1. */
export const PROXY_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Append-only writer for proxy.log. Directory creation is lazy and cached.
 * Growth is bounded: once the file passes maxBytes it is renamed to
 * `<file>.1` (single rollover, replacing any previous one) and restarted.
 */
export function createProxyEventLog(filePath: string, maxBytes = PROXY_LOG_MAX_BYTES): ProxyEventLog {
  let dirReady = false;
  // In-memory size estimate so the cap costs no extra stat per event;
  // -1 means "not measured yet" and is re-read lazily.
  let size = -1;
  return {
    filePath,
    event(text: string) {
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          dirReady = true;
        }
        const line = `${new Date().toISOString()} ${sanitizeEventText(text)}\n`;
        if (size < 0) size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          try {
            // The previous archive is moved aside rather than deleted up
            // front: if the active-log rename then fails, the archive is
            // restored instead of permanently lost.
            const archivePath = `${filePath}.1`;
            const backupPath = `${filePath}.1.bak`;
            fs.rmSync(backupPath, { force: true });
            const hadArchive = fs.existsSync(archivePath);
            if (hadArchive) fs.renameSync(archivePath, backupPath);
            try {
              fs.renameSync(filePath, archivePath);
            } catch (error) {
              if (hadArchive) fs.renameSync(backupPath, archivePath);
              throw error;
            }
            fs.rmSync(backupPath, { force: true });
            size = 0;
          } catch {
            // Rollover failed (for example the file is locked). Keep
            // appending so events are not lost, and retry on the next event.
            size = maxBytes;
          }
        }
        fs.appendFileSync(filePath, line);
        size += Buffer.byteLength(line);
      } catch {
        // Logging must never break request forwarding.
        dirReady = false;
        size = -1;
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
    // A JSON-RPC batch request is an array of payloads; normalize so batched
    // send_transaction calls are recorded like single ones.
    const parsed = JSON.parse(reqData) as JsonRpcRequestPayload | JsonRpcRequestPayload[];
    for (const jsonRpcContent of Array.isArray(parsed) ? parsed : [parsed]) {
      // Batch members are user input: JSON.parse happily yields null, strings,
      // or nested arrays. Skip anything that is not a plain object so one
      // malformed member cannot abort the rest of the batch.
      if (jsonRpcContent == null || typeof jsonRpcContent !== 'object' || Array.isArray(jsonRpcContent)) {
        ctx.sink.warn('skipping malformed JSON-RPC batch member');
        continue;
      }
      try {
        handleOneRequest(jsonRpcContent, ctx);
      } catch (error) {
        // Thrown values are not necessarily Error instances (user code can
        // throw anything), so normalize before logging; reading .message off
        // a non-Error (e.g. null) would itself throw and abort the batch.
        const message = error instanceof Error ? error.message : String(error);
        ctx.sink.warn(`skipping JSON-RPC request event: ${message}`);
      }
    }
  } catch (err) {
    ctx.sink.error('Error parsing JSON-RPC req content:', (err as Error).message);
  }
}

function handleOneRequest(jsonRpcContent: JsonRpcRequestPayload, ctx: ProxyEventContext): void {
  const method = jsonRpcContent.method;
  const params = jsonRpcContent.params;
  ctx.sink.debug('RPC Req: ', method);
  if (typeof method === 'string') {
    ctx.events.event(`request ${method}`);
  }

  if (method === 'send_transaction') {
    if (!Array.isArray(params) || params.length === 0) {
      ctx.sink.warn('send_transaction request has no params; skipping tx dump');
      return;
    }
    const tx = params[0];
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
}

interface JsonRpcErrorPayload {
  error?: { code?: unknown; message?: unknown };
}

export function handleProxyResponseBody(res: string, contentType: string | undefined, ctx: ProxyEventContext): void {
  if (res.length === 0) return;
  // Real servers answer with parameters attached (application/json;
  // charset=utf-8), so compare the bare media type, not the raw header.
  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return;
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
