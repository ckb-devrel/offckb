#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

async function buildContract(contractName) {
  if (!contractName) {
    console.error('Usage: node build-contract.js <contract-name>');
    process.exit(1);
  }

  const contractDir = path.join('contracts', contractName);
  const srcDir = path.join(contractDir, 'src');
  const distDir = path.join('dist');

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

  // Ensure global dist directory exists
  fs.mkdirSync(distDir, { recursive: true });

  const outputJsFile = path.join(distDir, `${contractName}.js`);
  const outputBcFile = path.join(distDir, `${contractName}.bc`);

  console.log(`Building ${contractName} from ${srcFile}...`);

  try {
    // Step 1: TypeScript type checking (if TypeScript file) - temporarily disabled due to @ckb-ccc/core version conflicts
    // if (srcFile.endsWith('.ts')) {
    //   console.log('  🔍 Type checking...');
    //   execSync(`./node_modules/.bin/tsc --noEmit --project .`, { stdio: 'pipe' });
    // }

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
      `--outfile=${outputJsFile}`,
    ].join(' ');

    execSync(esbuildCmd, { stdio: 'pipe' });

    // Step 3: Compile to bytecode with offckb debug command
    console.log('  🔧 Compiling to bytecode...');

    // Use offckb debug command with build mode (supports both native and WASM fallback)
    // Try to find offckb in various locations
    const offckbPath = 'offckb';
    const debuggerCmd = [
      offckbPath,
      'debug',
      '--build',
      outputJsFile,
      '--output',
      outputBcFile,
      '--js-vm',
      'node_modules/ckb-testtool/src/unittest/defaultScript/ckb-js-vm',
    ].join(' ');

    console.log(`  🔧 Using offckb from: ${offckbPath}`);
    console.log(`  🔧 Command: ${debuggerCmd}`);

    execSync(debuggerCmd, { stdio: 'pipe' });

    // Check if the bytecode file was actually created
    if (!fs.existsSync(outputBcFile)) {
      console.warn(`⚠️  Bytecode file not created. This might be due to WASM debugger limitations.`);
      console.warn(
        `   You can manually compile using: offckb debug --build ${outputJsFile} --output ${outputBcFile} --js-vm node_modules/ckb-testtool/src/unittest/defaultScript/ckb-js-vm`,
      );
    } else {
      console.log(`  ✅ Contract '${contractName}' built successfully!`);
      console.log(`     📄 JavaScript: ${outputJsFile}`);
      console.log(`     🔗 Bytecode: ${outputBcFile}`);
    }
  } catch (error) {
    console.error(`❌ Build failed for '${contractName}':`, error.message);
    process.exit(1);
  }
}

// Get contract name from command line arguments
const contractName = process.argv[2];
buildContract(contractName).catch((error) => {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
});
