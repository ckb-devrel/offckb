#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function buildContract(contractName) {
  if (!contractName) {
    console.error('Usage: node build-contract.js <contract-name>');
    process.exit(1);
  }

  const contractDir = path.join('contracts', contractName);
  const srcDir = path.join(contractDir, 'src');
  const distDir = path.join(contractDir, 'dist');
  
  // Check if contract exists
  if (!fs.existsSync(contractDir)) {
    console.error(`Contract '${contractName}' not found in contracts directory!`);
    process.exit(1);
  }

  // Find the main source file (index.ts or index.js)
  let srcFile;
  const tsFile = path.join(srcDir, 'index.ts');
  const jsFile = path.join(srcDir, 'index.js');
  
  if (fs.existsSync(tsFile)) {
    srcFile = tsFile;
  } else if (fs.existsSync(jsFile)) {
    srcFile = jsFile;
  } else {
    console.error(`No index.ts or index.js found in ${srcDir}`);
    process.exit(1);
  }

  // Ensure dist directory exists
  fs.mkdirSync(distDir, { recursive: true });
  
  const outputJsFile = path.join(distDir, 'index.js');
  const outputBcFile = path.join(distDir, 'index.bc');

  console.log(`Building ${contractName} from ${srcFile}...`);

  try {
    // Step 1: TypeScript type checking (if TypeScript file)
    if (srcFile.endsWith('.ts')) {
      console.log('  🔍 Type checking...');
      execSync(`./node_modules/.bin/tsc --noEmit --project .`, { stdio: 'pipe' });
    }

    // Step 2: Bundle with esbuild
    console.log('  📦 Bundling with esbuild...');
    const esbuildCmd = [
      './node_modules/.bin/esbuild',
      '--platform=neutral',
      '--minify',
      '--bundle',
      '--external:@ckb-js-std/bindings',
      '--target=es2022',
      srcFile,
      `--outfile=${outputJsFile}`
    ].join(' ');
    
    execSync(esbuildCmd, { stdio: 'pipe' });

    // Step 3: Compile to bytecode with ckb-debugger
    console.log('  🔧 Compiling to bytecode...');
    const debuggerCmd = [
      'ckb-debugger',
      `--read-file ${outputJsFile}`,
      '--bin node_modules/ckb-testtool/src/unittest/defaultScript/ckb-js-vm',
      '--',
      '-c',
      outputBcFile
    ].join(' ');
    
    execSync(debuggerCmd, { stdio: 'pipe' });

    console.log(`  ✅ Contract '${contractName}' built successfully!`);
    console.log(`     📄 JavaScript: ${outputJsFile}`);
    console.log(`     🔗 Bytecode: ${outputBcFile}`);

  } catch (error) {
    console.error(`❌ Build failed for '${contractName}':`, error.message);
    process.exit(1);
  }
}

// Get contract name from command line arguments
const contractName = process.argv[2];
buildContract(contractName);
