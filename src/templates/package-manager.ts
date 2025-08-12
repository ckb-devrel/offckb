import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export class PackageManagerDetector {
  /**
   * Detect package manager from lock files in current directory
   */
  detectFromLockFiles(projectDir: string = process.cwd()): PackageManager | null {
    const lockFiles = {
      'pnpm-lock.yaml': 'pnpm' as PackageManager,
      'yarn.lock': 'yarn' as PackageManager,
      'package-lock.json': 'npm' as PackageManager,
    };

    for (const [lockFile, manager] of Object.entries(lockFiles)) {
      if (fs.existsSync(path.join(projectDir, lockFile))) {
        return manager;
      }
    }

    return null;
  }

  /**
   * Detect available package managers from environment
   */
  detectFromEnvironment(): PackageManager | null {
    const managers: PackageManager[] = ['pnpm', 'yarn', 'npm'];

    for (const manager of managers) {
      try {
        execSync(`${manager} --version`, { stdio: 'ignore' });
        return manager;
      } catch {
        // Manager not available
      }
    }

    return null;
  }

  /**
   * Get default package manager
   */
  getDefault(): PackageManager {
    return 'npm';
  }

  /**
   * Main detection method
   */
  detect(projectDir?: string): PackageManager {
    // First try to detect from lock files
    const fromLockFiles = this.detectFromLockFiles(projectDir);
    if (fromLockFiles) {
      return fromLockFiles;
    }

    // Then try to detect from environment
    const fromEnvironment = this.detectFromEnvironment();
    if (fromEnvironment) {
      return fromEnvironment;
    }

    // Fallback to default
    return this.getDefault();
  }

  /**
   * Install dependencies using detected package manager
   */
  installDependencies(projectDir: string, packageManager: PackageManager): void {
    console.log(`Installing dependencies with ${packageManager}...`);

    try {
      const installCommands = {
        npm: 'npm install',
        yarn: 'yarn install',
        pnpm: 'pnpm install',
      };

      execSync(installCommands[packageManager], {
        cwd: projectDir,
        stdio: 'inherit',
      });

      console.log('Dependencies installed successfully!');
    } catch (error) {
      console.error(`Failed to install dependencies with ${packageManager}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Initialize git repository
   */
  initializeGit(projectDir: string): void {
    try {
      execSync('git --version', { stdio: 'ignore' });
      execSync('git init', { cwd: projectDir, stdio: 'ignore' });
      execSync('git add .', { cwd: projectDir, stdio: 'ignore' });
      execSync('git commit -m "Initial commit"', { cwd: projectDir, stdio: 'ignore' });
      console.log('Git repository initialized successfully!');
    } catch (error) {
      console.warn('Git initialization failed or git is not available. Skipping git setup.');
    }
  }
}
