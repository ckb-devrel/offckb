import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProxyEventLog, handleProxyRequestBody, handleProxyResponseBody } from '../src/tools/proxy-events';

function makeSink() {
  const sink = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return sink;
}

function makeCtx(transactionsPath: string) {
  return {
    sink: makeSink(),
    events: createProxyEventLog(path.join(path.dirname(transactionsPath), 'data', 'logs', 'proxy.log')),
    transactionsPath,
    hashTransaction: jest.fn(() => '0xhash'),
  };
}

describe('handleProxyRequestBody', () => {
  let dir: string;
  let transactionsPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-'));
    transactionsPath = path.join(dir, 'transactions');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('logs ordinary requests at debug level, not info', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyRequestBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip_header', params: [] }), ctx);
    expect(ctx.sink.debug).toHaveBeenCalledWith('RPC Req: ', 'get_tip_header');
    expect(ctx.sink.info).not.toHaveBeenCalled();
  });

  it('records every request in the proxy event log', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyRequestBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_tip_header', params: [] }), ctx);
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/request get_tip_header/);
  });

  it('keeps send_transaction hash visible at info and stores the tx file', () => {
    const ctx = makeCtx(transactionsPath);
    const tx = { cell_deps: [], inputs: [], outputs: [] };
    handleProxyRequestBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'send_transaction', params: [tx] }), ctx);
    expect(ctx.sink.info).toHaveBeenCalledWith(expect.stringContaining('0xhash'));
    expect(fs.existsSync(path.join(transactionsPath, '0xhash.json'))).toBe(true);
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/send_transaction 0xhash/);
  });

  it('reports malformed JSON-RPC bodies at error level', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyRequestBody('not json', ctx);
    expect(ctx.sink.error).toHaveBeenCalled();
  });

  it('ignores empty bodies', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyRequestBody('', ctx);
    expect(ctx.sink.debug).not.toHaveBeenCalled();
    expect(ctx.sink.error).not.toHaveBeenCalled();
  });
});

describe('handleProxyResponseBody', () => {
  it('warns on JSON-RPC errors and records them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-'));
    const ctx = makeCtx(path.join(dir, 'transactions'));
    handleProxyResponseBody(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -302, message: 'TransactionFailedToVerify' } }),
      'application/json',
      ctx,
    );
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('TransactionFailedToVerify'));
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/error .*TransactionFailedToVerify/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stays quiet on successful responses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-'));
    const ctx = makeCtx(path.join(dir, 'transactions'));
    handleProxyResponseBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), 'application/json', ctx);
    expect(ctx.sink.warn).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns for each error entry in a batch response', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-'));
    const ctx = makeCtx(path.join(dir, 'transactions'));
    handleProxyResponseBody(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: '0x0' },
        { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'boom' } },
      ]),
      'application/json',
      ctx,
    );
    expect(ctx.sink.warn).toHaveBeenCalledTimes(1);
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-JSON responses', () => {
    const ctx = makeCtx(path.join(os.tmpdir(), 'transactions'));
    handleProxyResponseBody('<html>not json</html>', 'text/html', ctx);
    expect(ctx.sink.warn).not.toHaveBeenCalled();
    expect(ctx.sink.error).not.toHaveBeenCalled();
  });
});
