#!/usr/bin/env node

/**
 * Deploy script for CKB contracts
 *
 * This script deploys all built contracts using the offckb deploy command.
 *
 * Fixed parameters:
 * - target: dist/ (where all built contracts are located)
 * - output: deployment/ (where deployment artifacts are saved)
 *
 * Environment variables accepted:
 * - NETWORK: Network to deploy to (devnet, testnet, mainnet) - defaults to devnet
 * - PRIVKEY: Private key for deployment - defaults to offckb's deployer account
 * - TYPE_ID: Whether to use upgradable type id (true/false) - defaults to false
 *
 * Usage:
 *   node scripts/deploy.js
 *   NETWORK=testnet node scripts/deploy.js
 *   NETWORK=testnet PRIVKEY=0x... node scripts/deploy.js
 *   NETWORK=testnet TYPE_ID=true node scripts/deploy.js
 */

import { spawn } from 'child_process';
import fs from 'fs';

function main() {
  // Fixed parameters for the template project
  const TARGET = 'dist';
  const OUTPUT = 'deployment';

  // Environment variables with defaults
  const NETWORK = process.env.NETWORK || 'devnet';
  const PRIVKEY = process.env.PRIVKEY;
  const TYPE_ID = process.env.TYPE_ID === 'true';

  // Validate that dist directory exists
  if (!fs.existsSync(TARGET)) {
    console.error('❌ Error: dist/ directory not found.');
    console.error('   Please run "npm run build" first to build your contracts.');
    process.exit(1);
  }

  // Check if there are any .bc files to deploy
  const distFiles = fs.readdirSync(TARGET);
  const bcFiles = distFiles.filter((file) => file.endsWith('.bc'));

  if (bcFiles.length === 0) {
    console.error('❌ Error: No .bc files found in dist/ directory.');
    console.error('   Please run "npm run build" first to build your contracts.');
    process.exit(1);
  }

  console.log('🚀 Deploying contracts...');
  console.log(`   📁 Target: ${TARGET}`);
  console.log(`   📄 Output: ${OUTPUT}`);
  console.log(`   🌐 Network: ${NETWORK}`);
  if (TYPE_ID) {
    console.log(`   🔄 Type ID: enabled (upgradable)`);
  }
  if (PRIVKEY) {
    console.log(`   🔑 Custom private key: provided`);
  }
  console.log('');

  // Build offckb deploy command
  const args = ['deploy', '--network', NETWORK, '--target', TARGET, '--output', OUTPUT];

  if (TYPE_ID) {
    args.push('--type-id');
  }

  if (PRIVKEY) {
    args.push('--privkey', PRIVKEY);
  }

  // Try to find offckb binary
  const offckbCommands = ['offckb', 'npx offckb', 'pnpm offckb', 'yarn offckb'];
  let offckbCmd = 'offckb';

  // For now, use 'offckb' directly - users should have it installed
  console.log(`💻 Running: ${offckbCmd} ${args.join(' ')}`);
  console.log('');

  // Execute the deploy command
  const deployProcess = spawn(offckbCmd, args, {
    stdio: 'inherit',
    shell: true,
  });

  deployProcess.on('close', (code) => {
    if (code === 0) {
      console.log('');
      console.log('🎉 Deployment completed successfully!');
      console.log(`📁 Deployment artifacts saved to: ${OUTPUT}/`);
      console.log('');
      console.log('💡 Next steps:');
      console.log('   - Check the deployment artifacts in the deployment/ folder');
      console.log('   - Update your tests to use the deployed contract addresses');
      console.log('   - Consider backing up your deployment files');
    } else {
      console.error('');
      console.error('❌ Deployment failed.');
      console.error(`   Exit code: ${code}`);
      process.exit(code);
    }
  });

  deployProcess.on('error', (error) => {
    console.error('❌ Error running deploy command:', error.message);
    console.error('');
    console.error('💡 Make sure offckb is installed:');
    console.error('   npm install -g offckb-cli');
    console.error('   # or');
    console.error('   pnpm add -g offckb-cli');
    process.exit(1);
  });
}

// Run main function if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
