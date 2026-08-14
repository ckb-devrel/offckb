import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProxyEventLog, handleProxyRequestBody, handleProxyResponseBody } from '../src/tools/proxy-events';

// renameSync goes through a mock so rollover failures can be simulated
// deterministically (same pattern as the fs.watchFile stub in
// logs-command.test.ts); the default delegates to the real implementation.
const mockRenameSync = jest.fn();
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

const realFs = jest.requireActual('fs') as typeof fs;
beforeEach(() => {
  mockRenameSync.mockImplementation(realFs.renameSync);
});

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

  it('records each entry of a batch request, including a batched send_transaction', () => {
    const ctx = makeCtx(transactionsPath);
    const tx = { cell_deps: [], inputs: [], outputs: [] };
    handleProxyRequestBody(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'get_tip_header', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'send_transaction', params: [tx] },
      ]),
      ctx,
    );
    expect(ctx.sink.info).toHaveBeenCalledWith(expect.stringContaining('0xhash'));
    expect(fs.existsSync(path.join(transactionsPath, '0xhash.json'))).toBe(true);
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/request get_tip_header/);
    expect(content).toMatch(/send_transaction 0xhash/);
  });

  it('skips malformed batch members and still records the requests after them', () => {
    const ctx = makeCtx(transactionsPath);
    const tx = { cell_deps: [], inputs: [], outputs: [] };
    handleProxyRequestBody(
      JSON.stringify([null, { jsonrpc: '2.0', id: 2, method: 'send_transaction', params: [tx] }]),
      ctx,
    );
    // The null member is skipped with a warning rather than aborting the batch.
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    expect(ctx.sink.error).not.toHaveBeenCalled();
    // The valid send_transaction after it is still recorded.
    expect(ctx.sink.info).toHaveBeenCalledWith(expect.stringContaining('0xhash'));
    expect(fs.existsSync(path.join(transactionsPath, '0xhash.json'))).toBe(true);
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/send_transaction 0xhash/);
  });

  it('isolates a failing batch member and still records a valid request after it', () => {
    const ctx = makeCtx(transactionsPath);
    // Simulate a member whose tx dump blows up mid-processing.
    ctx.hashTransaction = jest.fn((tx: unknown) => {
      if ((tx as { bad?: boolean }).bad) {
        throw new Error('hash boom');
      }
      return '0xhash';
    });
    const goodTx = { cell_deps: [], inputs: [], outputs: [] };
    handleProxyRequestBody(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'send_transaction', params: [{ bad: true }] },
        { jsonrpc: '2.0', id: 2, method: 'send_transaction', params: [goodTx] },
      ]),
      ctx,
    );
    // The failing member is skipped with a warning instead of aborting the batch.
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('hash boom'));
    expect(ctx.sink.error).not.toHaveBeenCalled();
    // The valid send_transaction after it is still recorded.
    expect(ctx.sink.info).toHaveBeenCalledWith(expect.stringContaining('0xhash'));
    expect(fs.existsSync(path.join(transactionsPath, '0xhash.json'))).toBe(true);
    const content = fs.readFileSync(ctx.events.filePath, 'utf8');
    expect(content).toMatch(/send_transaction 0xhash/);
  });

  it('warns and skips the tx dump when send_transaction has no usable params', () => {
    const ctx = makeCtx(transactionsPath);
    handleProxyRequestBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'send_transaction' }), ctx);
    expect(ctx.sink.warn).toHaveBeenCalledWith(expect.stringContaining('no params'));
    // A missing-params request is not a parse failure.
    expect(ctx.sink.error).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(transactionsPath, '0xhash.json'))).toBe(false);
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

  it('keeps appending when a rollover fails and retries on the next event', () => {
    const file = path.join(dir, 'logs', 'proxy.log');
    const log = createProxyEventLog(file, 60);
    log.event('request get_tip_header');
    log.event('request get_blockchain_info');

    // Block the rollover: every rename fails, so the active log stays put.
    mockRenameSync.mockImplementation(() => {
      throw new Error('rename blocked by test');
    });
    log.event('request get_tip_header');
    mockRenameSync.mockImplementation(realFs.renameSync);

    // The event is appended to the live file instead of being dropped.
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toMatch(/get_blockchain_info/);
    expect(current).toMatch(/get_tip_header/);

    // Once the blockage is gone the next event rolls over normally.
    log.event('request get_tip_header');
    const rolled = fs.readFileSync(`${file}.1`, 'utf8');
    expect(rolled).toMatch(/get_blockchain_info/);
    expect(rolled).toMatch(/get_tip_header/);
  });

  it('preserves the previous archive when the active-log rename fails', () => {
    const file = path.join(dir, 'logs', 'proxy.log');
    const log = createProxyEventLog(file, 60);
    log.event('request get_blockchain_info');
    // Second event rolls the log: .1 now holds the first generation.
    log.event('request get_tip_header');
    const archiveBefore = fs.readFileSync(`${file}.1`, 'utf8');
    expect(archiveBefore).toMatch(/get_blockchain_info/);

    // Fail only the active-log rename; the archive is moved aside first and
    // must be put back when the swap cannot complete.
    mockRenameSync.mockImplementation((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(oldPath) === file && String(newPath) === `${file}.1`) {
        throw new Error('active-log rename blocked by test');
      }
      return realFs.renameSync(oldPath, newPath);
    });
    log.event('request get_tip_block_hash');

    // The prior archive survived intact and no staging file was left behind.
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(archiveBefore);
    expect(fs.existsSync(`${file}.1.bak`)).toBe(false);
    // The event that triggered the failed rollover was appended, not dropped.
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toMatch(/get_tip_header/);
    expect(current).toMatch(/get_tip_block_hash/);
  });
});
