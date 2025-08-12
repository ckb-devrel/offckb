#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';

function askQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function validateContractName(name) {
  // Basic validation: alphanumeric and hyphens only
  const validNamePattern = /^[a-zA-Z0-9-_]+$/;
  return validNamePattern.test(name) && name.length > 0;
}

async function addContract() {
  let contractName = process.argv[2];

  // If contract name not provided, ask for it
  if (!contractName) {
    contractName = await askQuestion('Enter contract name: ');
  }

  // Validate contract name
  if (!validateContractName(contractName)) {
    console.error('❌ Invalid contract name. Use only alphanumeric characters, hyphens, and underscores.');
    process.exit(1);
  }

  // Check if contract already exists
  const contractDir = path.join('contracts', contractName);
  if (fs.existsSync(contractDir)) {
    console.error(`❌ Contract '${contractName}' already exists!`);
    process.exit(1);
  }

  // Detect project language from existing files
  let language = 'typescript'; // default
  if (fs.existsSync('tsconfig.json')) {
    language = 'typescript';
  } else {
    // Check if any existing contracts use JavaScript
    const contractsDir = 'contracts';
    if (fs.existsSync(contractsDir)) {
      const existingContracts = fs
        .readdirSync(contractsDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const existing of existingContracts) {
        const existingSrcDir = path.join(contractsDir, existing, 'src');
        if (fs.existsSync(path.join(existingSrcDir, 'index.js'))) {
          language = 'javascript';
          break;
        }
      }
    }
  }

  console.log(`📝 Creating new contract: ${contractName} (${language})`);

  try {
    // Create contract directory structure
    const srcDir = path.join(contractDir, 'src');
    const distDir = path.join(contractDir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    // Create main contract file
    const fileExtension = language === 'typescript' ? 'ts' : 'js';
    const contractFile = path.join(srcDir, `index.${fileExtension}`);

    const contractTemplate = `import * as bindings from '@ckb-js-std/bindings';
import { Script, HighLevel, log } from '@ckb-js-std/core';

function main()${language === 'typescript' ? ': number' : ''} {
  log.setLevel(log.LogLevel.Debug);
  let script = bindings.loadScript();
  log.debug(\`${contractName} script loaded: \${JSON.stringify(script)}\`);
  
  // Your contract logic here
  // This is a basic template that loads the script and logs its information
  
  return 0;
}

bindings.exit(main());`;

    fs.writeFileSync(contractFile, contractTemplate);

    // Create test file
    const testDir = 'tests';
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, `${contractName}.test.${fileExtension}`);

    const testTemplate = `import { hexFrom, Transaction, hashTypeToBytes } from '@ckb-ccc/core';
import { readFileSync } from 'fs';
import { Resource, Verifier, DEFAULT_SCRIPT_ALWAYS_SUCCESS, DEFAULT_SCRIPT_CKB_JS_VM } from 'ckb-testtool';

describe('${contractName} contract', () => {
  test('should execute successfully', async () => {
    const resource = Resource.default();
    const tx = Transaction.default();

    const mainScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
    const alwaysSuccessScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
    const contractScript = resource.deployCell(hexFrom(readFileSync('contracts/${contractName}/dist/${contractName}.bc')), tx, false);
    
    mainScript.args = hexFrom(
      '0x0000' +
        contractScript.codeHash.slice(2) +
        hexFrom(hashTypeToBytes(contractScript.hashType)).slice(2) +
        '0000000000000000000000000000000000000000000000000000000000000000',
    );

    // 1 input cell
    const inputCell = resource.mockCell(alwaysSuccessScript, mainScript, '0xFF000000000000000000000000000000');
    tx.inputs.push(Resource.createCellInput(inputCell));

    // 2 output cells
    tx.outputs.push(Resource.createCellOutput(alwaysSuccessScript, mainScript));
    tx.outputsData.push(hexFrom('0xFE000000000000000000000000000000'));
    tx.outputs.push(Resource.createCellOutput(alwaysSuccessScript, mainScript));
    tx.outputsData.push(hexFrom('0x01000000000000000000000000000000'));

    const verifier = Verifier.from(resource, tx);
    verifier.verifySuccess(true);
  });
});`;

    fs.writeFileSync(testFile, testTemplate);

    console.log(`✅ Contract '${contractName}' created successfully!`);
    console.log(`   📁 Contract: ${contractFile}`);
    console.log(`   🧪 Test: ${testFile}`);
    console.log('');
    console.log(`📖 Next steps:`);
    console.log(`   1. Edit your contract: ${contractFile}`);
    console.log(`   2. Build the contract: npm run build:contract ${contractName}`);
    console.log(`   3. Run tests: npm test -- ${contractName}`);
  } catch (error) {
    console.error(`❌ Failed to create contract '${contractName}':`, error.message);
    process.exit(1);
  }
}

addContract().catch(console.error);
