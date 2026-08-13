/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      statements: 10,
    },
    // Ratchet for the fiber lifecycle layer and the daemon identity module
    // (the fail-closed safety properties must stay regression-protected).
    // Thresholds sit below the current coverage on every CI platform —
    // POSIX-only tests skip on Windows, so the margins absorb that variance;
    // raise them as coverage grows, never lower them to make a run pass.
    './src/fiber/': {
      statements: 50,
      branches: 32,
      functions: 55,
      lines: 50,
    },
    './src/util/daemon.ts': {
      statements: 65,
      branches: 50,
      functions: 75,
      lines: 65,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
      },
    }],
  },
};
