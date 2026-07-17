import http from 'http';
import https from 'https';

// Minimal raw JSON-RPC caller. Unlike Request.send it never goes through the
// configured proxy, which makes it safe for talking to the local devnet node.
export async function callJsonRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = 30000,
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
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed.error) {
              reject(new Error(`JSON-RPC ${method} failed: ${JSON.stringify(parsed.error)}`));
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
