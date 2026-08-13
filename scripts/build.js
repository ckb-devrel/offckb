#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

console.log('🏗️  Building offckb CLI...\n');

try {
  // Step 1: TypeScript compilation
  console.log('📝 Compiling TypeScript...');
  execSync('tsc', { stdio: 'inherit' });
  console.log('✅ TypeScript compilation complete\n');

  // Step 2: Bundle with NCC
  console.log('🔗 Bundling with NCC...');
  execSync('ncc build dist/cli.js -o build --external cpu-features', { stdio: 'inherit' });
  console.log('✅ NCC bundling complete\n');

  // Step 3: Verify build output
  console.log('🔍 Verifying build output...');
  const buildFiles = ['build/index.js'];
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
