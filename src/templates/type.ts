export interface TemplateContext {
  projectName: string;
  projectPath?: string;
  language: 'typescript' | 'javascript';
  packageManager: 'npm' | 'yarn' | 'pnpm';
  contractName?: string;
}
