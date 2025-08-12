import { select, input, confirm } from '@inquirer/prompts';
import { PackageManagerDetector, PackageManager } from './package-manager';
import { TemplateContext } from './config';

export class InteractivePrompts {
  private packageManagerDetector: PackageManagerDetector;

  constructor() {
    this.packageManagerDetector = new PackageManagerDetector();
  }

  async getProjectName(providedName?: string): Promise<string> {
    if (providedName) {
      // If a name is provided (from command line), use it as-is
      // The path parsing will be handled by the create command
      return providedName;
    }

    const projectName = await input({
      message: 'What is your project name?',
      default: './my-ckb-project',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Project name cannot be empty';
        }
        return true;
      },
    });

    return projectName.trim();
  }

  async getLanguageChoice(): Promise<'typescript' | 'javascript'> {
    const language = await select({
      message: 'Which language would you like to use?',
      choices: [
        {
          name: 'TypeScript (recommended)',
          value: 'typescript' as const,
          description: 'Strong typing and better IDE support',
        },
        {
          name: 'JavaScript',
          value: 'javascript' as const,
          description: 'Simpler setup, no type checking',
        },
      ],
      default: 'typescript',
    });

    return language;
  }

  async getPackageManager(providedManager?: string): Promise<PackageManager> {
    if (providedManager) {
      const manager = providedManager.toLowerCase();
      if (['npm', 'yarn', 'pnpm'].includes(manager)) {
        return manager as PackageManager;
      }
    }

    // Try to detect automatically
    const detected = this.packageManagerDetector.detect();

    const shouldUseDetected = await confirm({
      message: `Use detected package manager: ${detected}?`,
      default: true,
    });

    if (shouldUseDetected) {
      return detected;
    }

    // Let user choose manually
    const packageManager = await select({
      message: 'Which package manager would you like to use?',
      choices: [
        {
          name: 'pnpm (recommended)',
          value: 'pnpm' as const,
          description: 'Fast, disk space efficient',
        },
        {
          name: 'yarn',
          value: 'yarn' as const,
          description: 'Fast, reliable, secure',
        },
        {
          name: 'npm',
          value: 'npm' as const,
          description: 'Default Node.js package manager',
        },
      ],
      default: 'pnpm',
    });

    return packageManager;
  }

  async shouldInstallDependencies(): Promise<boolean> {
    return await confirm({
      message: 'Install dependencies now?',
      default: true,
    });
  }

  async shouldInitializeGit(): Promise<boolean> {
    return await confirm({
      message: 'Initialize git repository?',
      default: true,
    });
  }

  async collectProjectInfo(
    providedProjectName?: string,
    providedLanguage?: string,
    providedPackageManager?: string,
    interactive: boolean = true,
  ): Promise<TemplateContext & { installDeps: boolean; initGit: boolean }> {
    let projectName: string;
    let language: 'typescript' | 'javascript';
    let packageManager: PackageManager;
    let installDeps: boolean = true;
    let initGit: boolean = true;

    if (interactive) {
      projectName = await this.getProjectName(providedProjectName);

      // Language selection
      if (providedLanguage) {
        const lang = providedLanguage.toLowerCase();
        if (['typescript', 'ts'].includes(lang)) {
          language = 'typescript';
        } else if (['javascript', 'js'].includes(lang)) {
          language = 'javascript';
        } else {
          language = await this.getLanguageChoice();
        }
      } else {
        language = await this.getLanguageChoice();
      }

      packageManager = await this.getPackageManager(providedPackageManager);
      installDeps = await this.shouldInstallDependencies();
      initGit = await this.shouldInitializeGit();
    } else {
      // Non-interactive mode - use defaults or provided values
      projectName = providedProjectName || 'my-ckb-project';

      if (providedLanguage) {
        const lang = providedLanguage.toLowerCase();
        if (['typescript', 'ts'].includes(lang)) {
          language = 'typescript';
        } else if (['javascript', 'js'].includes(lang)) {
          language = 'javascript';
        } else {
          language = 'typescript'; // default
        }
      } else {
        language = 'typescript'; // default
      }

      packageManager = (providedPackageManager as PackageManager) || this.packageManagerDetector.detect();
      installDeps = true; // default to installing dependencies
      initGit = true; // default to initializing git
    }

    return {
      projectName,
      language,
      packageManager,
      contractName: 'hello-world', // default contract name
      installDeps,
      initGit,
    };
  }
}
