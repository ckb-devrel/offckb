export interface TemplateContext {
  projectName: string;
  language: 'typescript' | 'javascript';
  packageManager: 'npm' | 'yarn' | 'pnpm';
  contractName?: string;
}

export interface TemplateDependencies {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  typescriptDevDeps: Record<string, string>;
}

export const TEMPLATE_CONFIG: TemplateDependencies = {
  dependencies: {
    '@ckb-js-std/bindings': '~0.1.0',
    '@ckb-js-std/core': '~0.1.1',
    dotenv: '^17.2.1',
  },
  devDependencies: {
    'ckb-testtool': '~0.1.1',
    '@ckb-ccc/core': '~1.5.3', // Pin to version compatible with ckb-testtool
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

export interface TemplateMetadata {
  name: string;
  description: string;
  supportedLanguages: ('typescript' | 'javascript')[];
  requiredFiles: string[];
  conditionalFiles: {
    typescript: string[];
    javascript: string[];
  };
}

export const BASE_TEMPLATE_METADATA: TemplateMetadata = {
  name: 'ckb-js-vm-base',
  description: 'Base template for CKB JavaScript VM projects',
  supportedLanguages: ['typescript', 'javascript'],
  requiredFiles: [
    'package.json.template',
    'jest.config.cjs.template',
    '.gitignore',
    'README.md.template',
    'deployment/scripts.json.template',
    'deployment/README.md.template',
    'env.example.template',
  ],
  conditionalFiles: {
    typescript: ['tsconfig.json.template', 'tsconfig.base.json.template'],
    javascript: [],
  },
};
