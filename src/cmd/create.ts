import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { TemplateProcessor } from '../templates/processor';
import { PackageManagerDetector } from '../templates/package-manager';
import { InteractivePrompts } from '../templates/prompts';

export interface CreateScriptProjectOptions {
  manager?: 'pnpm' | 'yarn' | 'npm';
  language?: 'typescript' | 'javascript' | 'ts' | 'js';
  interactive?: boolean;
  noInstall?: boolean;
  noGit?: boolean;
}

export async function createScriptProject(name?: string, options: CreateScriptProjectOptions = {}) {
  console.log(chalk.blue('🚀 Creating CKB JavaScript VM project...\n'));

  try {
    // Initialize services
    const prompts = new InteractivePrompts();
    const packageManagerDetector = new PackageManagerDetector();

    // Collect project information
    const projectInfo = await prompts.collectProjectInfo(
      name,
      options.language,
      options.manager,
      options.interactive !== false
    );

    // Override install/git options if provided
    if (options.noInstall) projectInfo.installDeps = false;
    if (options.noGit) projectInfo.initGit = false;

    const projectPath = path.resolve(projectInfo.projectName);

    // Check if directory already exists
    if (fs.existsSync(projectPath)) {
      console.error(chalk.red(`❌ Directory '${projectInfo.projectName}' already exists!`));
      process.exit(1);
    }

    console.log(chalk.gray(`📝 Project details:`));
    console.log(chalk.gray(`   Name: ${projectInfo.projectName}`));
    console.log(chalk.gray(`   Language: ${projectInfo.language}`));
    console.log(chalk.gray(`   Package Manager: ${projectInfo.packageManager}`));
    console.log(chalk.gray(`   Path: ${projectPath}\n`));

    // Get template directory (adjust path based on whether we're running from source or built)
    let templateDir: string;
    
    // Try to find the template directory
    const possiblePaths = [
      path.join(__dirname, '../../templates/v4/base-template'), // from built files
      path.join(process.cwd(), 'templates/v4/base-template'),   // from project root
      path.join(__dirname, '../../../templates/v4/base-template'), // alternative build location
    ];
    
    templateDir = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0];
    
    if (!fs.existsSync(templateDir)) {
      console.error(chalk.red(`❌ Template directory not found: ${templateDir}`));
      process.exit(1);
    }

    // Initialize template processor
    const processor = new TemplateProcessor(templateDir);

    // Generate project
    console.log(chalk.blue('📦 Generating project files...'));
    await processor.generateProject(projectPath, projectInfo);

    // Install dependencies
    if (projectInfo.installDeps) {
      console.log(chalk.blue('\n📥 Installing dependencies...'));
      try {
        packageManagerDetector.installDependencies(projectPath, projectInfo.packageManager);
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to install dependencies. You can install them manually later.'));
        console.warn(chalk.gray(`   Run: cd ${projectInfo.projectName} && ${projectInfo.packageManager} install`));
      }
    }

    // Initialize git repository
    if (projectInfo.initGit) {
      console.log(chalk.blue('\n🔧 Initializing git repository...'));
      try {
        packageManagerDetector.initializeGit(projectPath);
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to initialize git repository.'));
      }
    }

    // Success message
    console.log(chalk.green('\n🎉 Project created successfully!\n'));
    
    console.log(chalk.bold('📖 Next steps:'));
    console.log(chalk.gray(`   1. cd ${projectInfo.projectName}`));
    
    if (!projectInfo.installDeps) {
      console.log(chalk.gray(`   2. ${projectInfo.packageManager} install`));
      console.log(chalk.gray(`   3. ${projectInfo.packageManager} run build`));
      console.log(chalk.gray(`   4. ${projectInfo.packageManager} test`));
    } else {
      console.log(chalk.gray(`   2. ${projectInfo.packageManager} run build`));
      console.log(chalk.gray(`   3. ${projectInfo.packageManager} test`));
    }
    
    console.log(chalk.gray(`\n💡 To add a new contract:`));
    console.log(chalk.gray(`   ${projectInfo.packageManager} run add-contract <contract-name>`));

  } catch (error: unknown) {
    console.error(chalk.red('\n❌ Failed to create project:'), (error as Error).message);
    process.exit(1);
  }
}
