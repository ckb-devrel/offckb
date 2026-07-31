import { FiberContractsMissingError, resolveFiberChainScripts } from '../src/fiber/scripts';
import { SystemScript } from '../src/scripts/type';

const mockResolve = jest.fn();
jest.mock('../src/scripts/private', () => ({
  resolveDevnetSystemScripts: () => mockResolve(),
}));

function script(name: string, txHash: string, index: number, codeHash: string, hashType: 'type' | 'data2'): SystemScript {
  return {
    name,
    script: {
      codeHash: codeHash as `0x${string}`,
      hashType,
      cellDeps: [
        {
          cellDep: {
            outPoint: { txHash: txHash as `0x${string}`, index },
            depType: 'code',
          },
        },
      ],
    },
  };
}

const GENESIS_TX = '0xaaaa';

function fullRecord(): Record<string, SystemScript> {
  return {
    auth: script('auth', GENESIS_TX, 20, '0xauth', 'data2'),
    funding_lock: script('funding_lock', GENESIS_TX, 21, '0xfunding', 'data2'),
    commitment_lock: script('commitment_lock', GENESIS_TX, 22, '0xcommitment', 'data2'),
    sudt: script('sudt', GENESIS_TX, 5, '0xsudt', 'type'),
    xudt: script('xudt', GENESIS_TX, 6, '0xxudt', 'type'),
  };
}

describe('resolveFiberChainScripts', () => {
  beforeEach(() => mockResolve.mockReset());

  it('builds FundingLock/CommitmentLock with their own cell plus the auth cell', () => {
    mockResolve.mockReturnValue({ scripts: fullRecord(), forkedFrom: null, genesisHash: '0xgenesis' });
    const result = resolveFiberChainScripts();

    expect(result.genesisHash).toBe('0xgenesis');
    expect(result.fiberScripts).toHaveLength(2);

    const [funding, commitment] = result.fiberScripts;
    expect(funding.name).toBe('FundingLock');
    expect(funding.script).toEqual({ code_hash: '0xfunding', hash_type: 'data2', args: '0x' });
    expect(funding.cell_deps).toEqual([
      { cell_dep: { out_point: { tx_hash: GENESIS_TX, index: '0x15' }, dep_type: 'code' } },
      { cell_dep: { out_point: { tx_hash: GENESIS_TX, index: '0x14' }, dep_type: 'code' } },
    ]);
    expect(commitment.name).toBe('CommitmentLock');
    expect(commitment.cell_deps[0].cell_dep.out_point.index).toBe('0x16');
    expect(commitment.cell_deps[1].cell_dep.out_point.index).toBe('0x14');
  });

  it('anchors the UDT whitelist to the issuer lock hash with ^ and $', () => {
    mockResolve.mockReturnValue({ scripts: fullRecord(), forkedFrom: null, genesisHash: '0xgenesis' });
    const result = resolveFiberChainScripts();

    expect(result.udtWhitelist).toHaveLength(2);
    for (const udt of result.udtWhitelist) {
      expect(udt.script.args).toMatch(/^\^0x[0-9a-f]{64}\$$/);
    }
    expect(result.udtWhitelist[0].name).toBe('sudt');
    expect(result.udtWhitelist[1].name).toBe('xudt');
    expect(result.udtWhitelist[0].cell_deps[0].cell_dep.out_point).toEqual({ tx_hash: GENESIS_TX, index: '0x5' });
  });

  it('reports missing fiber contracts', () => {
    const record = fullRecord();
    delete (record as Record<string, unknown>).funding_lock;
    delete (record as Record<string, unknown>).commitment_lock;
    mockResolve.mockReturnValue({ scripts: record, forkedFrom: null, genesisHash: '0xgenesis' });

    try {
      resolveFiberChainScripts();
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FiberContractsMissingError);
      expect((error as FiberContractsMissingError).missing).toEqual(['funding_lock', 'commitment_lock']);
    }
  });

  it('throws when list-hashes is unavailable', () => {
    mockResolve.mockReturnValue(null);
    expect(() => resolveFiberChainScripts()).toThrow('list-hashes');
  });
});
