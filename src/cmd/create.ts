import * as fs from 'fs';
import * as path from 'path';
import { TemplateProcessor } from '../templates/processor';
import { PackageManagerDetector } from '../templates/package-manager';
import { InteractivePrompts } from '../templates/prompts';
import { genSystemScriptsJsonFile } from '../scripts/gen';
import { CKBDebugger } from '../tools/ckb-debugger';
import { logger } from '../util/logger';

export interface CreateScriptProjectOptions {
  manager?: 'pnpm' | 'yarn' | 'npm';
  language?: 'typescript' | 'javascript' | 'ts' | 'js';
  interactive?: boolean;
  install?: boolean; // Note: --no-install sets this to false
  git?: boolean; // Note: --no-git sets this to false
  contractName?: string; // Custom contract name for the first contract
}

export async function createScriptProject(name?: string, options: CreateScriptProjectOptions = {}) {
  logger.info(['🚀 Creating CKB JavaScript VM project...', '']);

  try {
    // Initialize services
    const prompts = new InteractivePrompts();
    const packageManagerDetector = new PackageManagerDetector();

    // Collect project information
    const projectInfo = await prompts.collectProjectInfo(
      name, // Pass the original name to let prompts handle path parsing in interactive mode
      options.language,
      options.manager,
      options.interactive !== false, // Interactive by default, unless explicitly disabled
      {
        noInstall: options.install === false, // --no-install sets install to false
        noGit: options.git === false, // --no-git sets git to false
      },
      options.contractName, // Pass the provided contract name
    );

    // Parse project name and path from the collected project info
    const { projectName, projectPath } = parseProjectNameAndPath(projectInfo.projectName);

    // Determine the contract name: CLI option or default
    const contractName = options.contractName || 'hello-world';

    // Override install/git options if provided
    if (options.install === false) projectInfo.installDeps = false;
    if (options.git === false) projectInfo.initGit = false;

    // Update the project info with the correct project name (without path) and contract name
    projectInfo.projectName = projectName;
    projectInfo.contractName = contractName;

    // Use the parsed project path instead of just the name
    const fullProjectPath = path.resolve(projectPath);

    // Check if directory already exists
    if (fs.existsSync(fullProjectPath)) {
      logger.error(`❌ Directory '${projectPath}' already exists!`);
      process.exit(1);
    }

    logger.info([
      '📝 Project details:',
      `   Name: ${projectInfo.projectName}`,
      `   Contract Name: ${contractName}`,
      `   Language: ${projectInfo.language}`,
      `   Package Manager: ${projectInfo.packageManager}`,
      `   Path: ${fullProjectPath}`,
      '',
    ]);

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
      logger.error(`❌ Template directory not found: ${templateDir}`);
      process.exit(1);
    }

    // Initialize template processor
    const processor = new TemplateProcessor(templateDir);

    // Generate project
    logger.info('📦 Generating project files...');

    // Add project path to context
    const contextWithPath = {
      ...projectInfo,
      projectPath: fullProjectPath,
    };

    await processor.generateProject(fullProjectPath, contextWithPath);

    // Generate system-scripts.json
    logger.info('🔧 Generating system scripts configuration...');
    try {
      const systemScriptsPath = path.join(fullProjectPath, 'deployment', 'system-scripts.json');
      genSystemScriptsJsonFile(systemScriptsPath);
      logger.success('✅ System scripts configuration generated successfully');
    } catch (error) {
      logger.warn([
        '⚠️  Failed to generate system scripts configuration.',
        '   You can generate it manually later with: offckb system-scripts -o deployment/system-scripts.json',
      ]);
    }

    // Install dependencies
    if (projectInfo.installDeps) {
      logger.info('\n📥 Installing dependencies...');
      try {
        packageManagerDetector.installDependencies(fullProjectPath, projectInfo.packageManager);
      } catch (error) {
        logger.warn([
          '⚠️  Failed to install dependencies. You can install them manually later.',
          `   Run: cd ${projectPath} && ${projectInfo.packageManager} install`,
        ]);
      }
    }

    // Initialize git repository
    if (projectInfo.initGit) {
      logger.info('\n🔧 Initializing git repository...');
      try {
        packageManagerDetector.initializeGit(fullProjectPath);
      } catch (error) {
        logger.warn('⚠️  Failed to initialize git repository.');
      }
    }

    // Success message
    logger.success('\n🎉 Project created successfully!\n');

    const steps = !projectInfo.installDeps
      ? [
          `cd ${projectPath}`,
          `${projectInfo.packageManager} install`,
          `${projectInfo.packageManager} run build`,
          `${projectInfo.packageManager} run deploy`,
          `${projectInfo.packageManager} run test`,
        ]
      : [
          `cd ${projectPath}`,
          `${projectInfo.packageManager} run build`,
          `${projectInfo.packageManager} run deploy`,
          `${projectInfo.packageManager} run test`,
        ];

    logger.list('📖 Next steps', steps);

    logger.info(['', '💡 To add a new contract:', `   ${projectInfo.packageManager} run add-contract <contract-name>`]);

    // check if ckb-debugger is installed
    if (!CKBDebugger.isBinaryInstalled() || !CKBDebugger.isBinaryVersionValid()) {
      logger.info(`Oho! You don't have ckb-debugger installed, let me create a fallback binary for you...`);
      CKBDebugger.createCkbDebuggerFallback();
    }
  } catch (error: unknown) {
    logger.error(`\n❌ Failed to create project: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Parse project name and path from the input string.
 * Supports formats like:
 * - "my-project" -> name: "my-project", path: "./my-project"
 * - "path/to/my-project" -> name: "my-project", path: "./path/to/my-project"
 * - "path\\to\\my-project" -> name: "my-project", path: "./path/to/my-project"
 */
export function parseProjectNameAndPath(input?: string): { projectName: string; projectPath: string } {
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
