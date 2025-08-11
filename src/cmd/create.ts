import { execSync } from 'child_process';

export interface CreateScriptProjectOptions {
  manager: 'pnpm' | 'yarn' | 'npm';
  isTypescript: boolean;
}

export function createScriptProject(name: string, options: CreateScriptProjectOptions) {
  const cmd = `${options.manager} create ckb-js-vm-app ${name}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
  } catch (error: unknown) {
    console.error('create script project failed, ', (error as Error).message);
  }
}
