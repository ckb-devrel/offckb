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
  let dir: string;
  let transactionsPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-'));
    transactionsPath = path.join(dir, 'transactions');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('warns on JSON-RPC errors and records them', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyResponseBody(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -302, message: 'TransactionFailedToVerify' } }),
      'application/json',
      ctx,
    );
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('TransactionFailedToVerify'));
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/error .*TransactionFailedToVerify/);
  });

  it('accepts a JSON content type with charset parameters', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyResponseBody(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -302, message: 'TransactionFailedToVerify' } }),
      'application/json; charset=utf-8',
      ctx,
    );
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('TransactionFailedToVerify'));
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/error .*TransactionFailedToVerify/);
  });

  it('stays quiet on successful responses', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyResponseBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), 'application/json', ctx);
    expect(ctx.sink.warn).not.toHaveBeenCalled();
  });

  it('warns for each error entry in a batch response', () => {
    const ctx = makeCtx(transactionsPath);
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
  });

  it('ignores non-JSON responses', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyResponseBody('<html>not json</html>', 'text/html', ctx);
    expect(ctx.sink.warn).not.toHaveBeenCalled();
    expect(ctx.sink.error).not.toHaveBeenCalled();
  });
});

describe('createProxyEventLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-proxy-log-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes one line per event even when fields contain newlines or control characters', () => {
    const file = path.join(dir, 'logs', 'proxy.log');
    const log = createProxyEventLog(file);
    const esc = String.fromCharCode(27);
    log.event(['request get_tip', 'forged'].join('\n') + '\r' + esc + '[31m');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('request get_tip forged');
    expect(lines[0]).not.toContain(esc);
    expect(lines[0]).not.toContain('\r');
  });

  it('rolls over to a single .1 file once the size cap is exceeded', () => {
    const file = path.join(dir, 'logs', 'proxy.log');
    const log = createProxyEventLog(file, 60);
    log.event('request get_tip_header');
    log.event('request get_blockchain_info');
    log.event('request get_tip_header');

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    // Single rollover: the .1 holds only the previous generation, the live
    // file only what came after the last rollover.
    const rolled = fs.readFileSync(`${file}.1`, 'utf8');
    expect(rolled).toMatch(/get_blockchain_info/);
    expect(rolled).not.toMatch(/get_tip_header/);
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toMatch(/get_tip_header/);
    expect(current).not.toMatch(/get_blockchain_info/);
  });
});
