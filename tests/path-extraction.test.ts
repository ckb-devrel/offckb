import { extractScriptNameFromPath } from '../src/scripts/util';
import * as os from 'os';

const isWindows = os.platform() === 'win32';
const isUnix = os.platform() !== 'win32'; // Unix-like (Mac, Linux, etc.)

describe('extractScriptNameFromPath', () => {
  // These tests run on all platforms - they use forward slashes which work everywhere
  describe('Bundled paths (Mac/Unix format)', () => {
    it('should extract script name from Bundled() wrapper with forward slashes', () => {
      const input = 'Bundled(specs/cells/secp256k1_blake160_sighash_all)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('secp256k1_blake160_sighash_all');
    });

    it('should extract script name from simple Bundled() path', () => {
      const input = 'Bundled(specs/cells/dao)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('dao');
    });

    it('should extract script name from Bundled() multisig path', () => {
      const input = 'Bundled(specs/cells/secp256k1_blake160_multisig_all)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('secp256k1_blake160_multisig_all');
    });
  });

  // Only run Unix/Mac-specific FileSystem path tests on Unix platforms
  (isUnix ? describe : describe.skip)('FileSystem paths (Mac/Unix format)', () => {
    it('should extract script name from Mac FileSystem() path with spaces', () => {
      const input = 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/anyone_can_pay)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('anyone_can_pay');
    });

    it('should extract script name from Mac FileSystem() path for sudt', () => {
      const input = 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/sudt)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('sudt');
    });

    it('should extract script name from Mac FileSystem() path for xudt', () => {
      const input = 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/xudt)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('xudt');
    });

    it('should extract script name from Mac FileSystem() path for omnilock', () => {
      const input = 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/omnilock)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('omnilock');
    });

    it('should extract script name from Mac FileSystem() path for spore', () => {
      const input = 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/spore)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('spore');
    });
  });

  // Only run Windows-specific path tests on Windows platform
  (isWindows ? describe : describe.skip)('FileSystem paths (Windows format)', () => {
    it('should extract script name from Windows FileSystem() path with backslashes', () => {
      const input = 'FileSystem(C:\\Users\\ajayh\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\anyone_can_pay)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('anyone_can_pay');
    });

    it('should extract script name from Windows FileSystem() path for sudt', () => {
      const input = 'FileSystem(C:\\Users\\ajayh\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\sudt)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('sudt');
    });

    it('should extract script name from Windows FileSystem() path for xudt', () => {
      const input = 'FileSystem(C:\\Users\\ajayh\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\xudt)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('xudt');
    });

    it('should extract script name from Windows FileSystem() path for omnilock', () => {
      const input = 'FileSystem(C:\\Users\\ajayh\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\omnilock)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('omnilock');
    });

    it('should extract script name from Windows FileSystem() path with different user', () => {
      const input = 'FileSystem(C:\\Users\\scz99\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\spore)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('spore');
    });
  });

  describe('Edge cases', () => {
    it('should handle path without wrapper (Unix)', () => {
      const input = '/some/path/to/script_name';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('script_name');
    });

    // Only test Windows paths on Windows
    (isWindows ? it : it.skip)('should handle Windows path without wrapper', () => {
      const input = 'C:\\some\\path\\to\\script_name';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('script_name');
    });

    it('should handle simple filename without path', () => {
      const input = 'simple_script';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('simple_script');
    });

    it('should handle Bundled() with single level path', () => {
      const input = 'Bundled(script_name)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('script_name');
    });

    it('should handle FileSystem() with single level path', () => {
      const input = 'FileSystem(script_name)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('script_name');
    });
  });

  describe('Real-world test cases from user reports', () => {
    // Only test Windows-specific case on Windows
    (isWindows ? it : it.skip)('should correctly extract anyone_can_pay on Windows (user report)', () => {
      // This was the failing case from the Windows user report
      const input = 'FileSystem(C:\\Users\\ajayh\\AppData\\Local\\offckb-nodejs\\Data\\devnet\\specs\\anyone_can_pay)';
      const result = extractScriptNameFromPath(input);
      expect(result).toBe('anyone_can_pay');
      
      // Verify it's NOT the full path
      expect(result).not.toContain('FileSystem');
      expect(result).not.toContain('\\');
      expect(result).not.toContain('C:');
    });

    // Only test Mac-specific case on Unix platforms
    (isUnix ? it : it.skip)('should correctly extract script names on Mac (actual output)', () => {
      // Real paths from Mac test output
      const testCases = [
        {
          input: 'Bundled(specs/cells/secp256k1_blake160_sighash_all)',
          expected: 'secp256k1_blake160_sighash_all',
        },
        {
          input: 'Bundled(specs/cells/dao)',
          expected: 'dao',
        },
        {
          input: 'Bundled(specs/cells/secp256k1_blake160_multisig_all)',
          expected: 'secp256k1_blake160_multisig_all',
        },
        {
          input: 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/sudt)',
          expected: 'sudt',
        },
        {
          input: 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/xudt)',
          expected: 'xudt',
        },
        {
          input: 'FileSystem(/Users/retric/Library/Application Support/offckb-nodejs/devnet/specs/omnilock)',
          expected: 'omnilock',
        },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = extractScriptNameFromPath(input);
        expect(result).toBe(expected);
      });
    });
  });
});
