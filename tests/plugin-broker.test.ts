import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { createHttpBridge, createReadRpcBroker } from '../src/plugins/broker';

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

const posixIt = process.platform === 'win32' ? it.skip : it;
posixIt('forwards HTTP over a plugin-initiated connection and enforces host response headers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-'));
  const socketPath = path.join(root, 'http.sock');
  const bridge = await createHttpBridge(socketPath, 0);
  const app = http.createServer((_req, res) => {
    res.setHeader('Content-Security-Policy', 'default-src *');
    res.end('sandboxed page');
  });
  const connection = net.connect(socketPath);
  connection.on('error', () => {});
  connection.once('connect', () => app.emit('connection', connection));
  try {
    const response = await fetch(bridge.url);
    expect(await response.text()).toBe('sandboxed page');
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain('default-src *');
  } finally {
    connection.destroy();
    bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
