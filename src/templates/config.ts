export interface PackageJsonConfig {
  version: string;
  description: string;
  private: boolean;
  type: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  typescriptDevDeps: Record<string, string>;
}

export const PACKAGE_JSON_CONFIG: PackageJsonConfig = {
  version: '0.1.0',
  description: 'CKB JavaScript Smart Contract project',
  private: true,
  type: 'module',
  scripts: {
    build: 'node scripts/build-all.js',
    'build:contract': 'node scripts/build-contract.js',
    test: 'node scripts/build-all.js && jest',
    'add-contract': 'node scripts/add-contract.js',
    deploy: 'node scripts/build-all.js && node scripts/deploy.js',
    clean: 'rimraf dist',
    format: 'prettier --write .',
  },
  dependencies: {
    '@ckb-js-std/bindings': '~1.0.0',
    '@ckb-js-std/core': '~1.0.0',
    dotenv: '^17.2.1',
  },
  devDependencies: {
    'ckb-testtool': '1.0.5',
    '@ckb-ccc/core': '1.12.2', // lock to version compatible with ckb-testtool
    esbuild: '~0.25.8',
    jest: '~29.7.0',
    prettier: '^3.5.3',
    rimraf: '^6.0.1',
  },
  typescriptDevDeps: {
    typescript: '~5.8.2',
    'ts-jest': '~29.2.6',
    '@types/node': '~22.13.8',
    '@types/jest': '~29.5.14',
  },
};

export const REQUIRED_FILES = [
  'package.json.template',
  'jest.config.cjs.template',
  'gitignore.template',
  'README.md.template',
  'deployment/scripts.json.template',
  'deployment/README.md.template',
  'env.example.template',
  'env.template',
];
