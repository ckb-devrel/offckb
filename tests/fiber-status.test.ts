import { lockMatches } from '../src/fiber/status';

/**
 * The funding-lock comparison shared by `fiber status` and the manager's
 * startup validation: case-insensitive, all three fields, no partial match.
 */
describe('lockMatches', () => {
  const expected = { codeHash: '0xAbC123', hashType: 'type', args: '0xDEADbeef' };

  it('matches a lock equal up to hex casing', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'TYPE', args: '0xdeadbeef' }, expected)).toBe(true);
  });

  it('rejects a missing lock', () => {
    expect(lockMatches(undefined, expected)).toBe(false);
  });

  it('rejects a differing code hash', () => {
    expect(lockMatches({ code_hash: '0x000000', hash_type: 'type', args: '0xdeadbeef' }, expected)).toBe(false);
  });

  it('rejects a differing hash type', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'data', args: '0xdeadbeef' }, expected)).toBe(false);
  });

  it('rejects differing args', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'type', args: '0x1234' }, expected)).toBe(false);
  });
});
