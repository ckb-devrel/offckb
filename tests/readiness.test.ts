const mockCallJsonRpc = jest.fn();

jest.mock('../src/util/json-rpc', () => ({
  callJsonRpc: (...args: unknown[]) => mockCallJsonRpc(...args),
}));

import { checkNodeReadiness } from '../src/devnet/readiness';

describe('checkNodeReadiness', () => {
  beforeEach(() => mockCallJsonRpc.mockReset());

  it('reports node, indexer lag and peer count', async () => {
    mockCallJsonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'local_node_info') return { version: '0.207.0' };
      if (method === 'get_tip_block_number') return '0x64';
      if (method === 'get_indexer_tip') return { block_number: '0x5a' };
      if (method === 'get_peers') return [{}, {}];
      throw new Error(method);
    });

    await expect(checkNodeReadiness('http://127.0.0.1:8114')).resolves.toEqual({
      ready: true,
      rpcUrl: 'http://127.0.0.1:8114',
      version: '0.207.0',
      nodeTip: 100n,
      indexerTip: 90n,
      indexerLag: 10n,
      peers: 2,
    });
  });

  it('does not confuse an open proxy with a healthy upstream node', async () => {
    mockCallJsonRpc.mockRejectedValue(new Error('Proxy error'));
    const result = await checkNodeReadiness('http://127.0.0.1:28114');
    expect(result.ready).toBe(false);
    expect(result.error).toContain('Proxy error');
  });

  it('keeps node readiness when the optional Indexer and Net modules are unavailable', async () => {
    mockCallJsonRpc.mockImplementation(async (_url: string, method: string) => {
      if (method === 'local_node_info') return { version: '0.207.0' };
      if (method === 'get_tip_block_number') return '0x1';
      throw new Error('module disabled');
    });
    const result = await checkNodeReadiness('http://127.0.0.1:8114');
    expect(result.ready).toBe(true);
    expect(result.indexerTip).toBeUndefined();
    expect(result.peers).toBeUndefined();
  });
});
