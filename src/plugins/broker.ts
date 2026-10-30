import http from 'http';
import net from 'net';

const READ_METHODS = new Set([
  'get_block',
  'get_block_by_number',
  'get_block_hash',
  'get_header',
  'get_header_by_number',
  'get_tip_header',
  'get_tip_block_number',
  'get_transaction',
  'get_live_cell',
  'get_cells',
  'get_cells_capacity',
  'get_transactions',
  'get_indexer_tip',
  'get_blockchain_info',
  'get_current_epoch',
  'get_epoch_by_number',
  'get_fee_rate_statistics',
  'estimate_fee_rate',
  'get_block_economic_state',
  'tx_pool_info',
  'get_raw_tx_pool',
]);

async function listen(server: net.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return (server.address() as net.AddressInfo).port;
}

/** Only fixed read methods reach the configured CKB endpoint; credentials remain in the host. */
export async function createReadRpcBroker(source: string): Promise<{ url: string; close: () => void }> {
  const target = new URL(source);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Sandbox devnet RPC requires HTTP(S)');
  const authorization =
    target.username || target.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64')}`
      : undefined;
  target.username = '';
  target.password = '';
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/' || !req.headers['content-type']?.startsWith('application/json')) {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 256 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const calls = Array.isArray(body) ? body : [body];
      if (
        calls.length === 0 ||
        calls.length > 200 ||
        calls.some(
          (call) => !call || call.jsonrpc !== '2.0' || !READ_METHODS.has(call.method) || !Array.isArray(call.params),
        )
      ) {
        res
          .writeHead(403, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'RPC method is not permitted' }));
        return;
      }
      const response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify(
          Array.isArray(body)
            ? calls.map((call) => ({ jsonrpc: '2.0', id: call.id ?? null, method: call.method, params: call.params }))
            : { jsonrpc: '2.0', id: body.id ?? null, method: body.method, params: body.params },
        ),
      });
      const result: Buffer[] = [];
      let responseSize = 0;
      if (!response.body) throw new Error('Empty RPC response');
      const reader = response.body.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        responseSize += chunk.length;
        if (responseSize > 16 * 1024 * 1024) throw new Error('RPC response too large');
        result.push(Buffer.from(chunk));
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(Buffer.concat(result));
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Devnet read request failed' }));
    }
  });
  try {
    const port = await listen(server, 0);
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  } catch (error) {
    server.close();
    throw error;
  }
}

/**
 * The plugin connects out to this private socket and serves HTTP on that connection.
 * The host never follows a plugin-writable socket pathname to another local service.
 */
export async function createHttpBridge(socketPath: string, port: number): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const idle: net.Socket[] = [];
  const waiters: Array<(socket?: net.Socket) => void> = [];
  const bridge = net.createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      const i = idle.indexOf(socket);
      if (i >= 0) idle.splice(i, 1);
    });
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else idle.push(socket);
  });
  const take = () =>
    new Promise<net.Socket>((resolve, reject) => {
      const ready = idle.shift();
      if (ready) {
        resolve(ready);
        return;
      }
      if (waiters.length >= 32) {
        reject(new Error('Bridge is busy'));
        return;
      }
      const done = (socket?: net.Socket) => {
        clearTimeout(timer);
        const i = waiters.indexOf(done);
        if (i >= 0) waiters.splice(i, 1);
        if (socket) resolve(socket);
        else reject(new Error('Plugin HTTP service is unavailable'));
      };
      const timer = setTimeout(() => done(), 3000);
      waiters.push(done);
    });
  const server = http.createServer(async (req, res) => {
    try {
      const socket = await take();
      const agent = new (class extends http.Agent {
        createConnection() {
          return socket;
        }
      })({ keepAlive: false });
      const upstream = http.request(
        {
          method: req.method,
          path: req.url,
          agent,
          headers: { 'Content-Type': req.headers['content-type'] ?? '', Connection: 'close' },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            'Content-Type': response.headers['content-type'] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin",
          });
          response.pipe(res);
        },
      );
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Plugin HTTP service is unavailable');
      });
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(503);
      res.end('Plugin HTTP service is unavailable');
    }
  });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  const close = () => {
    for (const waiter of [...waiters]) waiter();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
    bridge.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(socketPath, () => {
        bridge.removeListener('error', reject);
        resolve();
      });
    });
    return { url: `http://127.0.0.1:${await listen(server, port)}`, close };
  } catch (error) {
    close();
    throw error;
  }
}
