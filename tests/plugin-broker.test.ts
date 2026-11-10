import http from 'http';
import net from 'net';
import { createHttpBridge, createReadRpcBroker } from '../src/plugins/broker';

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Broker did not enforce its resource limit')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function readCall(url: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip_block_number', params: [] }),
  });
}

it('only forwards read RPC calls and keeps upstream credentials inside the host', async () => {
  const seen: Array<{ authorization?: string; body: string }> = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as net.AddressInfo).port;
  const broker = await createReadRpcBroker(`http://user:secret@127.0.0.1:${port}`);
  try {
    expect(broker.url).not.toContain('secret');
    const call = (method: string) =>
      fetch(broker.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      });
    expect((await call('get_tip_block_number')).status).toBe(200);
    expect((await call('send_transaction')).status).toBe(403);
    expect((await fetch(broker.url)).status).toBe(405);
    const read = { jsonrpc: '2.0', id: 2, method: 'get_block_by_number', params: ['0x0'] };
    const batch = (calls: unknown[]) =>
      fetch(broker.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calls),
      });
    expect((await batch([read, { ...read, method: 'send_transaction' }])).status).toBe(403);
    expect((await batch([])).status).toBe(403);
    expect((await batch(Array(201).fill(read))).status).toBe(403);
    expect(seen).toHaveLength(1); // Mixed/oversized batches must forward no partial calls.
    expect((await batch([read, read])).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0].authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
  } finally {
    broker.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});

it('length-delimits large JSON-RPC responses so proxies need not rely on FIN', async () => {
  const payload = { jsonrpc: '2.0', id: 1, result: `0x${'ab'.repeat(2_000_000)}` };
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const broker = await createReadRpcBroker(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`);
  try {
    const response = await fetch(broker.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip_block_number', params: [] }),
    });
    expect(response.headers.get('content-length')).toBe(String(JSON.stringify(payload).length));
    expect(await response.json()).toEqual(payload);
  } finally {
    broker.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});

it('drains and closes the latest idle socket without cutting off a subsequent request', async () => {
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before responding.
    }
    if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 200));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const broker = await createReadRpcBroker(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`);
  const socket = net.connect(Number(new URL(broker.url).port), '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  const started = Date.now();
  const closed = new Promise<number>((resolve) => socket.once('end', () => resolve(Date.now())));
  let received = Buffer.alloc(0);
  const request = () =>
    new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const headerEnd = received.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(/\r\nContent-Length: (\d+)\r\n/i.exec(received.subarray(0, headerEnd).toString())?.[1]);
        const total = headerEnd + 4 + length;
        if (!Number.isInteger(length) || received.length < total) return;
        cleanup();
        resolve(received.subarray(0, total).toString());
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('Socket closed before a complete response arrived'));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.removeListener('data', onData);
        socket.removeListener('end', onEnd);
        socket.removeListener('error', onError);
      };
      socket.on('data', onData);
      socket.once('end', onEnd);
      socket.once('error', onError);
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip_block_number', params: [] });
      socket.write(
        `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
      );
    });
  try {
    expect(await request()).toContain('0x0');
    // The second upstream response outlives the first response's 100ms timer.
    expect(await request()).toContain('0x0');
    expect(await within(closed, 2000)).toBeGreaterThanOrEqual(started + 200);
    expect(calls).toBe(2);
  } finally {
    broker.close();
    socket.destroy();
    upstream.closeAllConnections();
    upstream.close();
  }
}, 5000);

it('bounds concurrent RPC work and connections, and cancels in-flight upstream reads when closed', async () => {
  let seen = 0;
  let cancelled = 0;
  let ready!: () => void;
  let stopped!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const allCancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.once('close', () => {
      if (++cancelled === 8) stopped();
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // An unfinished upstream body holds a concurrency slot.
    if (++seen === 8) ready();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const broker = await createReadRpcBroker(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`);
  const clients = Array.from({ length: 8 }, () =>
    readCall(broker.url).then(
      () => false,
      () => true,
    ),
  );
  const sockets: net.Socket[] = [];
  try {
    await within(allStarted, 3000);
    expect((await readCall(broker.url)).status).toBe(503);
    expect(seen).toBe(8);
    let rejected!: () => void;
    const connectionRefused = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    for (let i = 0; i < 20; i++) {
      const socket = net.connect(Number(new URL(broker.url).port), '127.0.0.1');
      sockets.push(socket);
      socket.on('error', () => {});
      socket.once('close', rejected);
      socket.once('connect', () => socket.write('POST / HTTP/1.1\r\n'));
    }
    await within(connectionRefused, 2000); // No header deadline has elapsed; the connection cap rejected it.
    broker.close();
    await within(allCancelled, 2000);
    expect(await Promise.all(clients)).toEqual([true, true, true, true, true, true, true, true]);
  } finally {
    broker.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(clients);
    upstream.closeAllConnections();
    upstream.close();
  }
}, 15000);

it('expires slow headers, incomplete bodies and stalled upstreams with the same wall-clock deadline', async () => {
  let seen = 0;
  let cancelled!: () => void;
  const upstreamCancelled = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const upstream = http.createServer((req, res) => {
    seen++;
    req.resume();
    res.once('close', cancelled);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const broker = await createReadRpcBroker(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`, 100);
  const slow = [
    'POST / HTTP/1.1\r\nHost: 127',
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{',
  ].map((request) => {
    const socket = net.connect(Number(new URL(broker.url).port), '127.0.0.1');
    socket.on('error', () => {});
    socket.once('connect', () => socket.write(request));
    socket.resume();
    return { socket, closed: new Promise<void>((resolve) => socket.once('close', () => resolve())) };
  });
  const client = readCall(broker.url).then(
    (response) => response.status,
    () => null,
  );
  try {
    await within(Promise.all([...slow.map((s) => s.closed), upstreamCancelled]), 7000);
    expect(await client).toBeNull();
    expect(seen).toBe(1); // Partial requests never reached the configured node.
  } finally {
    broker.close();
    for (const { socket } of slow) socket.destroy();
    await client;
    upstream.closeAllConnections();
    upstream.close();
  }
}, 10000);

it('forwards HTTP over a plugin-initiated connection and enforces host response headers', async () => {
  const bridge = await createHttpBridge(0);
  const app = http.createServer((_req, res) => {
    res.setHeader('Content-Security-Policy', 'default-src *');
    res.end('sandboxed page');
  });
  const connect = () => net.connect(Number(bridge.endpoint.split(':')[1]), '127.0.0.1');
  const invalid = connect();
  const refused = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unauthenticated connection was not rejected')), 1000);
    invalid.on('error', () => {});
    invalid.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    invalid.once('connect', () => invalid.write('offckb-http/1 wrong-token\n'));
  });
  const connection = connect();
  connection.on('error', () => {});
  const authenticated = new Promise<void>((resolve) => {
    connection.once('connect', () => connection.write(`offckb-http/1 ${bridge.token}\n`));
    connection.once('data', (data) => {
      expect(data.toString()).toBe('OK\n');
      app.emit('connection', connection);
      resolve();
    });
  });
  try {
    await refused;
    await authenticated;
    const response = await fetch(bridge.url);
    expect(await response.text()).toBe('sandboxed page');
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain('default-src *');
  } finally {
    connection.destroy();
    bridge.close();
    invalid.destroy();
  }
});
