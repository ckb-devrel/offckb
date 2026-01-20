#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function buildAllContracts(isDebug = false) {
  const contractsDir = path.join(process.cwd(), 'contracts');

  if (!fs.existsSync(contractsDir)) {
    console.error('No contracts directory found!');
    process.exit(1);
  }

  const contracts = fs
    .readdirSync(contractsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  if (contracts.length === 0) {
    console.log('No contracts found to build.');
    return;
  }

  console.log(`Building ${contracts.length} contract(s): ${contracts.join(', ')}`);

  for (const contractName of contracts) {
    console.log(`\n📦 Building contract: ${contractName}`);
    try {
      const buildScriptPath = path.join('scripts', 'build-contract.js');
      execSync(`node "${buildScriptPath}" ${contractName} ${isDebug ? '--debug' : ''}`, { stdio: 'inherit' });
      console.log(`✅ Successfully built: ${contractName} with ${isDebug ? 'debug' : 'release'} version`);
    } catch (error) {
      console.error(`❌ Failed to build: ${contractName}`);
      console.error(error.message);
      process.exit(1);
    }
  }

  console.log(`\n🎉 All contracts built successfully!`);
}

buildAllContracts(process.argv.includes('--debug'));
