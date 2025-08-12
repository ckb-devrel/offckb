import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { TemplateProcessor } from '../templates/processor';
import { PackageManagerDetector } from '../templates/package-manager';
import { InteractivePrompts } from '../templates/prompts';
import { genSystemScriptsJsonFile } from '../scripts/gen';

/**
 * Parse project name and path from the input string.
 * Supports formats like:
 * - "my-project" -> name: "my-project", path: "./my-project"
 * - "path/to/my-project" -> name: "my-project", path: "./path/to/my-project"
 * - "path\\to\\my-project" -> name: "my-project", path: "./path/to/my-project"
 */
function parseProjectNameAndPath(input?: string): { projectName: string; projectPath: string } {
  if (!input) {
    return { projectName: 'my-ckb-project', projectPath: './my-ckb-project' };
  }

  const normalizedInput = input.trim();

  // Normalize path separators to forward slashes for consistency
  const normalizedPath = normalizedInput.replace(/\\/g, '/');

  // If input contains path separators, extract the project name from the last part
  if (normalizedPath.includes('/')) {
    const projectName = path.basename(normalizedPath);
    const projectPath = normalizedPath;
    return { projectName, projectPath };
  }

  // If it's just a name, use it as both name and path
  return { projectName: normalizedInput, projectPath: `./${normalizedInput}` };
}

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
      name, // Pass the original name to let prompts handle path parsing in interactive mode
      options.language,
      options.manager,
      options.interactive !== false,
    );

    // Parse project name and path from the collected project info
    const { projectName, projectPath } = parseProjectNameAndPath(projectInfo.projectName);

    // Override install/git options if provided
    if (options.noInstall) projectInfo.installDeps = false;
    if (options.noGit) projectInfo.initGit = false;

    // Update the project info with the correct project name (without path)
    projectInfo.projectName = projectName;

    // Use the parsed project path instead of just the name
    const fullProjectPath = path.resolve(projectPath);

    // Check if directory already exists
    if (fs.existsSync(fullProjectPath)) {
      console.error(chalk.red(`❌ Directory '${projectPath}' already exists!`));
      process.exit(1);
    }

    console.log(chalk.gray(`📝 Project details:`));
    console.log(chalk.gray(`   Name: ${projectInfo.projectName}`));
    console.log(chalk.gray(`   Language: ${projectInfo.language}`));
    console.log(chalk.gray(`   Package Manager: ${projectInfo.packageManager}`));
    console.log(chalk.gray(`   Path: ${fullProjectPath}\n`));

    // Try to find the template directory
    const possiblePaths = [
      path.join(__dirname, '../../templates/v4/base-template'), // from built files
      path.join(process.cwd(), 'templates/v4/base-template'), // from project root
      path.join(__dirname, '../../../templates/v4/base-template'), // alternative build location
      path.join(__dirname, '../templates/v4/base-template'), // from source files
    ];

    // Get template directory (adjust path based on whether we're running from source or built)
    const templateDir = possiblePaths.find((p) => fs.existsSync(p)) || possiblePaths[0];

    if (!fs.existsSync(templateDir)) {
      console.error(chalk.red(`❌ Template directory not found: ${templateDir}`));
      process.exit(1);
    }

    // Initialize template processor
    const processor = new TemplateProcessor(templateDir);

    // Generate project
    console.log(chalk.blue('📦 Generating project files...'));
    await processor.generateProject(fullProjectPath, projectInfo);

    // Generate system-scripts.json
    console.log(chalk.blue('🔧 Generating system scripts configuration...'));
    try {
      const systemScriptsPath = path.join(fullProjectPath, 'deployment', 'system-scripts.json');
      genSystemScriptsJsonFile(systemScriptsPath);
      console.log(chalk.green('✅ System scripts configuration generated successfully'));
    } catch (error) {
      console.warn(chalk.yellow('⚠️  Failed to generate system scripts configuration.'));
      console.warn(
        chalk.gray(
          '   You can generate it manually later with: offckb system-scripts -o deployment/system-scripts.json',
        ),
      );
    }

    // Install dependencies
    if (projectInfo.installDeps) {
      console.log(chalk.blue('\n📥 Installing dependencies...'));
      try {
        packageManagerDetector.installDependencies(fullProjectPath, projectInfo.packageManager);
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to install dependencies. You can install them manually later.'));
        console.warn(chalk.gray(`   Run: cd ${projectPath} && ${projectInfo.packageManager} install`));
      }
    }

    // Initialize git repository
    if (projectInfo.initGit) {
      console.log(chalk.blue('\n🔧 Initializing git repository...'));
      try {
        packageManagerDetector.initializeGit(fullProjectPath);
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to initialize git repository.'));
      }
    }

    // Success message
    console.log(chalk.green('\n🎉 Project created successfully!\n'));

    console.log(chalk.bold('📖 Next steps:'));
    console.log(chalk.gray(`   1. cd ${projectPath}`));

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
