#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🏗️  Building offckb CLI...\n');

try {
  // Step 1: TypeScript compilation
  console.log('📝 Compiling TypeScript...');
  execSync('tsc', { stdio: 'inherit' });
  console.log('✅ TypeScript compilation complete\n');

  // Step 2: Bundle with NCC
  console.log('🔗 Bundling with NCC...');
  execSync('ncc build dist/cli.js -o build --external cpu-features', { stdio: 'inherit' });
  // Ship the official runtime once, without its unused entry point, types or snippets.
  const biscuitSource = 'node_modules/@biscuit-auth/biscuit-wasm/module';
  const biscuitModule = new WebAssembly.Module(fs.readFileSync(path.join(biscuitSource, 'biscuit_bg.wasm')));
  const biscuitFiles = [
    'biscuit_bg.wasm',
    ...new Set(WebAssembly.Module.imports(biscuitModule).map((entry) => entry.module)),
  ];
  fs.rmSync('build/biscuit', { recursive: true, force: true });
  for (const file of biscuitFiles) {
    const target = path.join('build/biscuit', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(biscuitSource, file), target);
  }
  fs.writeFileSync('build/biscuit/package.json', JSON.stringify({ type: 'module' }));
  fs.copyFileSync('node_modules/@biscuit-auth/biscuit-wasm/LICENSE', 'build/biscuit/LICENSE');
  console.log('✅ NCC bundling complete\n');

  // Step 3: Verify build output
  console.log('🔍 Verifying build output...');
  const buildFiles = [
    'build/index.js',
    ...biscuitFiles.map((file) => path.join('build/biscuit', file)),
    'build/biscuit/package.json',
    'build/biscuit/LICENSE',
  ];
  let allFilesExist = true;

  for (const file of buildFiles) {
    if (fs.existsSync(file)) {
      const stats = fs.statSync(file);
      console.log(`  ✅ ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      console.log(`  ❌ ${file} (missing)`);
      allFilesExist = false;
    }
  }

  if (allFilesExist) {
    console.log('\n🎉 Build completed successfully!');
  } else {
    console.error('\n❌ Build completed with missing files');
    process.exit(1);
  }
} catch (error) {
  console.error('\n❌ Build failed:', error.message);
  process.exit(1);
}
