import * as net from 'net';
import { EventEmitter } from 'events';
import { parseTcpListenAddress, parseSubscriptionMessage, subscribeToNodeLogs } from '../src/devnet/log-subscription';

// connect is routed through a mock so retry behavior can be driven with a
// fake socket; by default it delegates to the real implementation.
const mockConnect = jest.fn();
jest.mock('net', () => ({
  ...jest.requireActual('net'),
  connect: (...args: unknown[]) => mockConnect(...args),
}));
const realConnect = (jest.requireActual('net') as typeof net).connect;

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

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
  beforeEach(() => {
    mockConnect.mockReset();
    mockConnect.mockImplementation((...args: unknown[]) =>
      (realConnect as (...a: unknown[]) => net.Socket)(...args),
    );
  });

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

  it('does not reconnect once an established subscription drops', async () => {
    const socket = new FakeSocket();
    mockConnect.mockReturnValue(socket as unknown as net.Socket);
    const errors: Error[] = [];
    const sub = subscribeToNodeLogs('127.0.0.1:18114', () => {}, (err) => errors.push(err), {
      maxAttempts: 3,
      retryDelayMs: 30,
    });

    socket.emit('connect');
    expect(socket.written.join('')).toContain('"subscribe"');
    // A mid-run drop is terminal for the subscription (the supervisor tears
    // the service down): no reconnect, no failure report.
    socket.emit('error', new Error('read ECONNRESET'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    sub.close();
  });

  it('close() cancels a reconnect pending from the initial connect phase', async () => {
    const socket = new FakeSocket();
    mockConnect.mockReturnValue(socket as unknown as net.Socket);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const sub = subscribeToNodeLogs('127.0.0.1:18114', () => {}, () => {}, {
      maxAttempts: 5,
      retryDelayMs: 50,
    });

    try {
      // The first attempt fails before ever connecting, so a retry is pending.
      socket.emit('error', new Error('connect ECONNREFUSED'));
      sub.close();
      // The pending timer is cancelled, not left to no-op on the closed guard.
      expect(clearTimeoutSpy).toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mockConnect).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
