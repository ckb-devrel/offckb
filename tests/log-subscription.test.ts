import * as net from 'net';
import { parseTcpListenAddress, parseSubscriptionMessage, subscribeToNodeLogs } from '../src/devnet/log-subscription';

describe('parseTcpListenAddress', () => {
  it('splits host and port', () => {
    expect(parseTcpListenAddress('127.0.0.1:18114')).toEqual({ host: '127.0.0.1', port: 18114 });
  });

  it('rejects invalid addresses', () => {
    expect(parseTcpListenAddress('no-port')).toBeNull();
    expect(parseTcpListenAddress('127.0.0.1:notaport')).toBeNull();
    expect(parseTcpListenAddress('')).toBeNull();
  });
});

describe('parseSubscriptionMessage', () => {
  it('parses the subscribe response into a subscription id', () => {
    expect(parseSubscriptionMessage('{"jsonrpc":"2.0","result":"0x49af29b770e3502239e4510ff58f8d59","id":1}')).toEqual({
      subscriptionId: '0x49af29b770e3502239e4510ff58f8d59',
    });
  });

  it('parses a log notification into an entry', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        result: {
          message: 'script group: 0xabcd DEBUG OUTPUT: hello',
          level: 'DEBUG',
          target: 'ckb-script',
          date: '2026-07-29 11:40:01.500 +00:00',
        },
        subscription: '0x49af',
      },
    });
    expect(parseSubscriptionMessage(line)).toEqual({
      entry: {
        message: 'script group: 0xabcd DEBUG OUTPUT: hello',
        level: 'DEBUG',
        target: 'ckb-script',
        date: '2026-07-29 11:40:01.500 +00:00',
      },
    });
  });

  it('returns null for garbage and unrelated messages', () => {
    expect(parseSubscriptionMessage('not json')).toBeNull();
    expect(parseSubscriptionMessage('{"jsonrpc":"2.0","method":"other","params":{}}')).toBeNull();
  });
});

describe('subscribeToNodeLogs', () => {
  it('subscribes over TCP and emits log entries until closed', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        const request = JSON.parse(data.toString().trim());
        expect(request.method).toBe('subscribe');
        expect(request.params).toEqual(['log']);
        socket.write(JSON.stringify({ jsonrpc: '2.0', result: '0xsub', id: request.id }) + '\n');
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'subscribe',
            params: {
              result: {
                message: 'hello',
                level: 'DEBUG',
                target: 'ckb-script',
                date: '2026-07-29 11:40:01.500 +00:00',
              },
              subscription: '0xsub',
            },
          }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const entries: unknown[] = [];
    const errors: Error[] = [];
    const sub = subscribeToNodeLogs(
      `127.0.0.1:${port}`,
      (entry) => entries.push(entry),
      (err) => errors.push(err),
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    sub.close();
    server.close();

    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { message: 'hello', level: 'DEBUG', target: 'ckb-script', date: '2026-07-29 11:40:01.500 +00:00' },
    ]);
  });

  it('retries briefly then reports an error when the node is unreachable', async () => {
    const errors: Error[] = [];
    const sub = subscribeToNodeLogs(
      '127.0.0.1:1',
      () => {},
      (err) => errors.push(err),
      {
        maxAttempts: 2,
        retryDelayMs: 50,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    sub.close();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/log subscription/i);
  });
});
