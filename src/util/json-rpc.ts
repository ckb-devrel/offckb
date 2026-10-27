import http from 'http';
import https from 'https';

export class JsonRpcError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly rpcCode?: number,
  ) {
    super(message);
  }
}

// Minimal raw JSON-RPC caller. Unlike Request.send it never goes through the
// configured proxy, which makes it safe for talking to the local devnet node.
export async function callJsonRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = 30000,
  headers: Record<string, string> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const body = JSON.stringify({ id: 1, jsonrpc: '2.0', method, params });
  const url = new URL(rpcUrl);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        // The response stream can error or close before `end` (connection
        // reset, truncated body). Without these listeners the promise would
        // hang until the request timeout — or the process would crash on an
        // unhandled stream error.
        res.once('error', reject);
        res.on('close', () => {
          if (!res.complete) {
            reject(new Error(`JSON-RPC ${method} to ${rpcUrl} returned a truncated response`));
          }
        });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new JsonRpcError(`JSON-RPC ${method}: authentication failed or permission denied`, res.statusCode));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed.error) {
              reject(
                new JsonRpcError(
                  `JSON-RPC ${method} failed: ${JSON.stringify(parsed.error)}`,
                  res.statusCode,
                  parsed.error.code,
                ),
              );
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(new Error(`Invalid JSON-RPC response from ${rpcUrl}: ${(error as Error).message}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`JSON-RPC ${method} to ${rpcUrl} timed out`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
