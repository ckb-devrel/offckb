import { normalizePrivKey } from '../src/util/validator';

describe('normalizePrivKey', () => {
  const validHex64 = '1234567812345678123456781234567812345678123456781234567812345678';

  it('should throw an error for empty or formatting values', () => {
    expect(() => normalizePrivKey('')).toThrow('Private key is required.');
    expect(() => normalizePrivKey('   ')).toThrow('Private key is required.');
  });

  it('should accept a 64-character hex string without 0x prefix', () => {
    const key = validHex64;
    expect(normalizePrivKey(key)).toBe('0x' + key);
  });

  it('should accept a 64-character hex string with 0x prefix', () => {
    const key = '0x' + validHex64;
    expect(normalizePrivKey(key)).toBe('0x' + validHex64);
  });

  it('should accept a 64-character hex string with 0X prefix (case-insensitive)', () => {
    const key = '0X' + validHex64;
    expect(normalizePrivKey(key)).toBe('0x' + validHex64);
  });

  it('should correctly trim spaces inside quotes', () => {
    const key = `'  0x${validHex64}  '`;
    expect(normalizePrivKey(key)).toBe('0x' + validHex64);

    const key2 = `" 0X${validHex64} "`;
    expect(normalizePrivKey(key2)).toBe('0x' + validHex64);
  });

  it('should throw an error if the key contains non-hexadecimal characters', () => {
    const invalidHex = validHex64.slice(0, -1) + 'G'; // Replace last char with 'G' (invalid hex)
    expect(() => normalizePrivKey(invalidHex)).toThrow('Invalid private key: contains non-hexadecimal characters.');
  });

  it('should throw an error if the key length is incorrect', () => {
    const shortKey = validHex64.slice(0, 62);
    expect(() => normalizePrivKey(shortKey)).toThrow('Invalid private key length');

    const longKey = validHex64 + '12';
    expect(() => normalizePrivKey(longKey)).toThrow('Invalid private key length');
  });
});
