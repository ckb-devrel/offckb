# CKB-JS-VM Create Command Implementation Plan

## Overview

This document outlines the implementation plan for enhancing the `offckb create` command to generate standalone CKB JavaScript script projects using ckb-js-vm, with focus on maintainability, flexibility, and ease of use.

## Requirements

1. **Multiple Package Manager Support**: yarn/npm/pnpm/npx
2. **No Workspace Dependencies**: Generate standalone projects
3. **Language Options**: TypeScript/JavaScript support  
4. **Contract Management**: Easy "add new contract" functionality
5. **High Maintainability**: Single source of truth, automated validation

## Technical Architecture

### CKB-JS-VM Understanding

- **Runtime**: QuickJS engine running ES2022 JavaScript on CKB blockchain
- **Build Pipeline**: TypeScript → esbuild bundle → ckb-debugger bytecode
- **Core Dependencies**: `@ckb-js-std/bindings`, `@ckb-js-std/core`
- **Testing**: ckb-testtool with Jest integration

### Build Process Flow
```bash
1. tsc --noEmit                           # Type checking
2. esbuild --target=es2022 --bundle       # JavaScript bundling  
3. ckb-debugger --compile                 # Bytecode compilation
```

## Implementation Strategy

### 1. Template System Design

**Single Template Approach** (Maintainable)
```
templates/v4/
└── base-template/
    ├── _template.config.json              # Template metadata
    ├── contracts/
    │   └── {{CONTRACT_NAME}}/
    │       ├── src/
    │       │   ├── index.ts.template      # TypeScript version
    │       │   └── index.js.template      # JavaScript version
    │       └── package.json.template
    ├── tests/
    │   ├── contract.test.ts.template
    │   └── contract.test.js.template
    ├── scripts/
    │   ├── build-all.js                   # Cross-platform build scripts
    │   ├── build-contract.js
    │   └── add-contract.js
    ├── package.json.template
    ├── tsconfig.json.template             # Conditional for TypeScript
    ├── tsconfig.base.json.template
    ├── jest.config.cjs.template
    ├── .gitignore
    └── README.md.template
```

### 2. Configuration Management

**Central Dependency Management**
```typescript
// src/templates/config.ts
export const TEMPLATE_CONFIG = {
  dependencies: {
    '@ckb-js-std/bindings': '~0.1.0',
    '@ckb-js-std/core': '~0.1.1'
  },
  devDependencies: {
    'ckb-testtool': '~0.1.1',
    'esbuild': '~0.25.8',
    'jest': '~29.7.0',
    'prettier': '^3.5.3',
    'rimraf': '^6.0.1'
  },
  typescriptDevDeps: {
    'typescript': '~5.8.2',
    'ts-jest': '~29.2.6',
    '@types/node': '~22.13.8',
    '@types/jest': '~29.5.14'
  }
};
```

### 3. Template Processing Engine

**Smart Template System**
```typescript
interface TemplateContext {
  projectName: string;
  language: 'typescript' | 'javascript';
  packageManager: 'npm' | yarn' | 'pnpm';
  contractName?: string;
}

class TemplateProcessor {
  // Process template files with variable substitution
  processTemplate(templatePath: string, context: TemplateContext): string;
  
  // Determine which files to include based on language choice
  shouldIncludeFile(filePath: string, context: TemplateContext): boolean;
  
  // Generate package.json with correct dependencies
  generatePackageJson(context: TemplateContext): object;
  
  // Copy and process entire template directory
  generateProject(outputDir: string, context: TemplateContext): void;
}
```

### 4. Enhanced CLI Interface

**Command Structure**
```bash
offckb create [project-name] [options]

Options:
  -m, --manager <npm|yarn|pnpm>    Package manager choice (auto-detected)
  -l, --language <ts|js>           Language preference (default: ts)
  -i, --interactive               Interactive mode (default: true)
  --no-git                        Skip git initialization
  --no-install                    Skip dependency installation
```

**Interactive Prompts**
- Project name (if not provided)
- Language preference (TypeScript/JavaScript)
- Package manager (with auto-detection)
- Git initialization confirmation

### 5. Package Manager Detection

**Detection Strategy**
```typescript
class PackageManagerDetector {
  detectFromLockFiles(): string | null;     // Check for lock files
  detectFromEnvironment(): string | null;   // Check available binaries
  getDefault(): string;                     // Fallback to npm
  
  // Returns: npm, yarn, or pnpm
  detect(): string;
}
```

### 6. Project Structure Generated

**Generated Project Layout**
```
my-ckb-project/
├── contracts/
│   └── hello-world/
│       ├── src/
│       │   └── index.ts (or .js)
│       └── dist/ (generated during build)
├── tests/
│   └── hello-world.test.ts (or .js)
├── scripts/
│   ├── build-all.js
│   ├── build-contract.js
│   └── add-contract.js
├── package.json
├── tsconfig.json (TypeScript only)
├── tsconfig.base.json (TypeScript only)
├── jest.config.cjs
├── .gitignore
└── README.md
```

### 7. Build System Integration

**Package.json Scripts**
```json
{
  "scripts": {
    "build": "node scripts/build-all.js",
    "build:contract": "node scripts/build-contract.js",
    "test": "jest",
    "add-contract": "node scripts/add-contract.js",
    "clean": "rimraf contracts/*/dist",
    "format": "prettier --write ."
  }
}
```

**Cross-Platform Build Scripts**
```javascript
// scripts/build-contract.js
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function buildContract(contractName) {
  const contractDir = path.join('contracts', contractName);
  const srcFile = path.join(contractDir, 'src', 'index.ts');
  const distDir = path.join(contractDir, 'dist');
  
  // Ensure dist directory exists
  fs.mkdirSync(distDir, { recursive: true });
  
  // Build JavaScript bundle
  execSync(`esbuild --platform=neutral --minify --bundle --external:@ckb-js-std/bindings --target=es2022 ${srcFile} --outfile=${distDir}/index.js`);
  
  // Compile to bytecode
  execSync(`ckb-debugger --read-file ${distDir}/index.js --bin node_modules/ckb-testtool/src/unittest/defaultScript/ckb-js-vm -- -c ${distDir}/index.bc`);
}
```

### 8. Add Contract Functionality

**Add Contract Script**
```javascript
// scripts/add-contract.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function addContract(contractName) {
  // Validate contract name
  // Create contract directory structure
  // Copy template files with name substitution
  // Generate test file
  // Update any necessary configurations
}
```

**Usage Example**
```bash
npm run add-contract my-new-contract
# Creates: contracts/my-new-contract/src/index.ts
# Creates: tests/my-new-contract.test.ts
```

### 9. Template Content Examples

**Basic Contract Template**
```typescript
// contracts/{{CONTRACT_NAME}}/src/index.ts.template
import * as bindings from '@ckb-js-std/bindings';
import { Script, HighLevel, log } from '@ckb-js-std/core';

function main(): number {
  log.setLevel(log.LogLevel.Debug);
  let script = bindings.loadScript();
  log.debug(`{{CONTRACT_NAME}} script loaded: ${JSON.stringify(script)}`);
  
  // Your contract logic here
  
  return 0;
}

bindings.exit(main());
```

**Test Template**
```typescript
// tests/{{CONTRACT_NAME}}.test.ts.template
import { hexFrom, Transaction, hashTypeToBytes } from '@ckb-ccc/core';
import { readFileSync } from 'fs';
import { Resource, Verifier, DEFAULT_SCRIPT_ALWAYS_SUCCESS, DEFAULT_SCRIPT_CKB_JS_VM } from 'ckb-testtool';

describe('{{CONTRACT_NAME}} contract', () => {
  test('should execute successfully', async () => {
    const resource = Resource.default();
    const tx = Transaction.default();
    
    const mainScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
    const alwaysSuccessScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
    const contractScript = resource.deployCell(hexFrom(readFileSync('contracts/{{CONTRACT_NAME}}/dist/index.bc')), tx, false);
    
    // Contract deployment and testing logic
    
    const verifier = Verifier.from(resource, tx);
    verifier.verifySuccess(true);
  });
});
```

## Implementation Steps

### Phase 1: Infrastructure Setup
1. Create template configuration system
2. Implement template processing engine
3. Set up package manager detection
4. Create base template structure

### Phase 2: Core Implementation  
1. Update create command with new interface
2. Implement template generation logic
3. Add interactive prompts
4. Create cross-platform build scripts

### Phase 3: Contract Management
1. Implement add-contract functionality
2. Create contract templates
3. Add contract validation
4. Test multi-contract projects

### Phase 4: Testing & Documentation
1. Automated template testing
2. Cross-platform compatibility testing
3. Package manager compatibility testing
4. Documentation generation

## Maintainability Benefits

### Single Source of Truth
- One template directory with conditional inclusion
- Central dependency version management
- Shared build utilities across all generated projects

### Automated Validation
- Template generation tests ensure functionality
- Build pipeline verification catches breaking changes
- Cross-platform compatibility automated testing

### Extensibility Design
- Plugin system for new contract types
- Configurable build steps
- Easy template customization without code changes

### Platform Compatibility
- Node.js-based scripts work on all platforms
- No shell script dependencies
- Proper error handling and logging

## Success Criteria

1. **Functional**: Generate working ckb-js-vm projects with both TypeScript and JavaScript
2. **Flexible**: Support all major package managers seamlessly
3. **Maintainable**: Easy to update dependencies and templates
4. **User-Friendly**: Intuitive CLI with helpful prompts and documentation
5. **Robust**: Cross-platform compatibility and proper error handling

## Migration Strategy

- **No Backward Compatibility Required**: Clean slate implementation
- **Template Location**: New `v4/` directory for clear separation
- **Testing Strategy**: Generate and build projects with all combinations
- **Rollout**: Replace existing implementation entirely

---

**Ready for implementation upon approval.**
