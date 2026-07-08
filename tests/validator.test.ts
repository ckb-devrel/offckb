import {
  normalizePrivKey,
  isValidUdtKind,
  validateUdtKind,
  validateUdtAmount,
  validateUdtTypeArgs,
} from '../src/util/validator';

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

describe('UDT validation helpers', () => {
  describe('isValidUdtKind', () => {
    it('should accept sudt and xudt', () => {
      expect(isValidUdtKind('sudt')).toBe(true);
      expect(isValidUdtKind('xudt')).toBe(true);
    });

    it('should reject other strings', () => {
      expect(isValidUdtKind('')).toBe(false);
      expect(isValidUdtKind('SUDT')).toBe(false);
      expect(isValidUdtKind('unknown')).toBe(false);
    });
  });

  describe('validateUdtKind', () => {
    it('should accept sudt and xudt', () => {
      expect(() => validateUdtKind('sudt')).not.toThrow();
      expect(() => validateUdtKind('xudt')).not.toThrow();
    });

    it('should reject invalid kinds', () => {
      expect(() => validateUdtKind('')).toThrow('--udt-kind is required');
      expect(() => validateUdtKind('SUDT')).toThrow('invalid UDT kind');
    });
  });

  describe('validateUdtAmount', () => {
    it('should accept non-negative decimal integers', () => {
      expect(validateUdtAmount('0')).toBe(0n);
      expect(validateUdtAmount('1')).toBe(1n);
      expect(validateUdtAmount('123456789012345678901234567890')).toBe(123456789012345678901234567890n);
    });

    it('should reject negative, decimal, hex, scientific and empty values', () => {
      expect(() => validateUdtAmount('-1')).toThrow('invalid UDT amount');
      expect(() => validateUdtAmount('1.5')).toThrow('invalid UDT amount');
      expect(() => validateUdtAmount('0x10')).toThrow('invalid UDT amount');
      expect(() => validateUdtAmount('1e10')).toThrow('invalid UDT amount');
      expect(() => validateUdtAmount('')).toThrow('invalid UDT amount');
      expect(() => validateUdtAmount('abc')).toThrow('invalid UDT amount');
    });
  });

  describe('validateUdtTypeArgs', () => {
    it('should accept valid SUDT type args', () => {
      const args = '0x' + '12'.repeat(20);
      expect(validateUdtTypeArgs('sudt', args)).toBe(args);
    });

    it('should accept valid xUDT type args', () => {
      const args = '0x' + '12'.repeat(32);
      expect(validateUdtTypeArgs('xudt', args)).toBe(args);
    });

    it('should reject invalid hex', () => {
      expect(() => validateUdtTypeArgs('sudt', 'not-hex')).toThrow('invalid type args');
      expect(() => validateUdtTypeArgs('sudt', '')).toThrow('invalid type args');
    });

    it('should reject wrong lengths', () => {
      expect(() => validateUdtTypeArgs('sudt', '0x' + '12'.repeat(19))).toThrow('invalid SUDT type args length');
      expect(() => validateUdtTypeArgs('sudt', '0x' + '12'.repeat(32))).toThrow('invalid SUDT type args length');
      expect(() => validateUdtTypeArgs('xudt', '0x' + '12'.repeat(31))).toThrow('invalid xUDT type args length');
    });
  });
});
