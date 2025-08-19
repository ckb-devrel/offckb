import * as fs from 'fs';
import * as path from 'path';
import { TemplateContext, TEMPLATE_CONFIG, BASE_TEMPLATE_METADATA } from './config';

export class TemplateProcessor {
  private templateDir: string;

  constructor(templateDir: string) {
    this.templateDir = templateDir;
  }

  /**
   * Process template string with variable substitution
   */
  processTemplate(templateContent: string, context: TemplateContext): string {
    let processed = templateContent;

    // Handle conditional blocks for TypeScript
    const isTypescript = context.language === 'typescript';

    // Process template conditionals
    // Must process blocks with {{else}} first, then simple blocks

    // Process {{#if_typescript}} ... {{else}} ... {{/if_typescript}}
    processed = processed.replace(
      /\{\{#if_typescript\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if_typescript\}\}/g,
      (match, ifContent, elseContent) => {
        return isTypescript ? ifContent : elseContent;
      },
    );

    // Process {{#if_javascript}} ... {{else}} ... {{/if_javascript}}
    processed = processed.replace(
      /\{\{#if_javascript\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if_javascript\}\}/g,
      (match, ifContent, elseContent) => {
        return !isTypescript ? ifContent : elseContent;
      },
    );

    // Process {{#if_typescript}} ... {{/if_typescript}} (without else)
    processed = processed.replace(/\{\{#if_typescript\}\}([\s\S]*?)\{\{\/if_typescript\}\}/g, (match, content) => {
      return isTypescript ? content : '';
    });

    // Process {{#if_javascript}} ... {{/if_javascript}} (without else)
    processed = processed.replace(/\{\{#if_javascript\}\}([\s\S]*?)\{\{\/if_javascript\}\}/g, (match, content) => {
      return !isTypescript ? content : '';
    });

    // Replace simple template variables
    processed = processed.replace(/\{\{PROJECT_NAME\}\}/g, context.projectName);
    processed = processed.replace(/\{\{PROJECT_PATH\}\}/g, context.projectPath || '.');
    processed = processed.replace(/\{\{CONTRACT_NAME\}\}/g, context.contractName || 'hello-world');
    processed = processed.replace(/\{\{LANGUAGE\}\}/g, context.language);
    processed = processed.replace(/\{\{PACKAGE_MANAGER\}\}/g, context.packageManager);

    return processed;
  }

  /**
   * Determine if a file should be included based on language choice
   */
  shouldIncludeFile(filePath: string, context: TemplateContext): boolean {
    const relativePath = path.relative(this.templateDir, filePath);
    const fileName = path.basename(filePath);

    // Exclude template metadata files
    if (fileName === '_template.config.json') {
      return false;
    }

    // Always include required files
    if (BASE_TEMPLATE_METADATA.requiredFiles.some((reqFile) => relativePath.includes(reqFile))) {
      return true;
    }

    // Handle language-specific jest config files
    if (fileName.includes('jest.config.cjs.')) {
      if (context.language === 'typescript') {
        return fileName.includes('.ts.template');
      } else {
        return fileName.includes('.js.template');
      }
    }

    // Handle helper files - always include for matching language
    if (fileName.includes('helper.')) {
      if (context.language === 'typescript') {
        return fileName.includes('.ts.template');
      } else {
        return fileName.includes('.js.template');
      }
    }

    // Handle test files - include both mock and devnet tests for the appropriate language
    if (fileName.includes('.test.') || fileName.includes('.mock.test.') || fileName.includes('.devnet.test.')) {
      if (context.language === 'typescript') {
        return fileName.includes('.ts.template');
      } else {
        return fileName.includes('.js.template');
      }
    }

    // Check conditional files for contracts and other files
    if (context.language === 'typescript') {
      return !relativePath.includes('.js.template') || relativePath.includes('.ts.template');
    } else {
      return !relativePath.includes('.ts.template') || relativePath.includes('.js.template');
    }
  }

  /**
   * Generate package.json with correct dependencies
   */
  generatePackageJson(context: TemplateContext): object {
    const basePackageJson = {
      name: context.projectName,
      version: '0.1.0',
      description: 'CKB JavaScript Smart Contract project',
      private: true,
      type: 'module',
      scripts: {
        build: 'node scripts/build-all.js',
        'build:contract': 'node scripts/build-contract.js',
        test: 'jest',
        'add-contract': 'node scripts/add-contract.js',
        clean: 'rimraf contracts/*/dist',
        format: 'prettier --write .',
      },
      dependencies: TEMPLATE_CONFIG.dependencies,
      devDependencies: { ...TEMPLATE_CONFIG.devDependencies },
    };

    // Add TypeScript dependencies if needed
    if (context.language === 'typescript') {
      Object.assign(basePackageJson.devDependencies, TEMPLATE_CONFIG.typescriptDevDeps);
    }

    return basePackageJson;
  }

  /**
   * Copy and process a single file
   */
  async processFile(sourcePath: string, targetPath: string, context: TemplateContext): Promise<void> {
    let finalTargetPath = targetPath.replace(/\.template$/, '');

    // Handle language-specific files (e.g., jest.config.cjs.ts.template -> jest.config.cjs)
    const fileName = path.basename(finalTargetPath);
    if (fileName.includes('jest.config.cjs.')) {
      const dir = path.dirname(finalTargetPath);
      finalTargetPath = path.join(dir, 'jest.config.cjs');
    }

    // Handle env.example.template -> .env.example
    if (fileName === 'env.example') {
      const dir = path.dirname(finalTargetPath);
      finalTargetPath = path.join(dir, '.env.example');
    }

    // Handle env.template -> .env
    if (fileName === 'env') {
      const dir = path.dirname(finalTargetPath);
      finalTargetPath = path.join(dir, '.env');
    }

    // Handle gitignore.template -> .gitignore
    if (fileName === 'gitignore') {
      const dir = path.dirname(finalTargetPath);
      finalTargetPath = path.join(dir, '.gitignore');
    }

    // Ensure target directory exists
    const targetDir = path.dirname(finalTargetPath);
    fs.mkdirSync(targetDir, { recursive: true });

    // Read and process template
    const templateContent = fs.readFileSync(sourcePath, 'utf-8');
    const processedContent = this.processTemplate(templateContent, context);

    // Write processed content
    fs.writeFileSync(finalTargetPath, processedContent);
  }

  /**
   * Recursively copy and process template directory
   */
  async processDirectory(sourceDir: string, targetDir: string, context: TemplateContext): Promise<void> {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);

      if (entry.isDirectory()) {
        // Process subdirectory recursively
        const processedDirName = this.processTemplate(entry.name, context);
        const processedTargetPath = path.join(targetDir, processedDirName);
        fs.mkdirSync(processedTargetPath, { recursive: true });
        await this.processDirectory(sourcePath, processedTargetPath, context);
      } else if (entry.isFile()) {
        // Check if file should be included
        if (this.shouldIncludeFile(sourcePath, context)) {
          const processedFileName = this.processTemplate(entry.name, context);
          const processedTargetPath = path.join(targetDir, processedFileName);
          await this.processFile(sourcePath, processedTargetPath, context);
        }
      }
    }
  }

  /**
   * Generate complete project from template
   */
  async generateProject(outputDir: string, context: TemplateContext): Promise<void> {
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Process template directory
    await this.processDirectory(this.templateDir, outputDir, context);

    // Generate package.json separately to ensure correct structure
    const packageJsonPath = path.join(outputDir, 'package.json');
    const packageJsonContent = this.generatePackageJson(context);
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJsonContent, null, 2));
  }
}
