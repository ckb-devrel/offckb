import http from 'http';
import { AddressInfo } from 'net';
import { callJsonRpc } from '../src/util/json-rpc';

describe('callJsonRpc', () => {
  let server: http.Server;
  let rpcUrl: string;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function startServer(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    rpcUrl = `http://127.0.0.1:${port}`;
  }

  it('resolves with the result on a normal response', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 1, jsonrpc: '2.0', result: '0x42' }));
    });
    await expect(callJsonRpc(rpcUrl, 'get_tip_block_number', [])).resolves.toBe('0x42');
  });

  it('rejects on a JSON-RPC error payload', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } }));
    });
    await expect(callJsonRpc(rpcUrl, 'nope', [])).rejects.toThrow('Method not found');
  });

  it('rejects instead of hanging when the response is truncated mid-body', async () => {
    await startServer((_req, res) => {
      // Declare a full JSON body but only send half of it, then kill the socket.
      const body = JSON.stringify({ id: 1, jsonrpc: '2.0', result: '0x42' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.write(body.slice(0, 5));
      res.socket?.destroy();
    });
    await expect(callJsonRpc(rpcUrl, 'get_tip_block_number', [])).rejects.toThrow(
      /truncated|aborted|socket|other side closed/i,
    );
  });

  it('rejects when the connection cannot be established', async () => {
    // Port 1 is reserved and never listens.
    await expect(callJsonRpc('http://127.0.0.1:1', 'get_tip_block_number', [], 3000)).rejects.toThrow();
  });
});
