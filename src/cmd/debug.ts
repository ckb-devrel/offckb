import { readSettings } from '../cfg/setting';
import { CKBDebugger } from '../tools/ckb-debugger';
import fs from 'fs';
import { dumpTransaction } from '../tools/ckb-tx-dumper';
import path from 'path';
import { cccA } from '@ckb-ccc/core/advanced';
import { Network } from '../type/base';
import { encodeBinPathForTerminal } from '../util/encoding';
import { logger } from '../util/logger';

export function debugTransaction(txHash: string, network: Network) {
  const txFile = buildTxFileOptionBy(txHash, network);
  const opts = buildTransactionDebugOptions(txHash, network);
  for (const opt of opts) {
    logger.section(opt.name, [], 'info');
    debugRaw(`${txFile} ${opt.cmdOption}`);
  }
}

export function buildTransactionDebugOptions(txHash: string, network: Network) {
  const txJsonFilePath = buildTransactionJsonFilePath(network, txHash);
  const txJson = JSON.parse(fs.readFileSync(txJsonFilePath, 'utf-8'));
  const cccTx = cccA.JsonRpcTransformers.transactionTo(txJson);

  const result = [];
  for (const [index, input] of cccTx.inputs.entries()) {
    result.push({
      name: `Input[${index}].Lock`,
      cmdOption: `--cell-index ${index} --cell-type input --script-group-type lock`,
    });
    if (input.cellOutput?.type) {
      result.push({
        name: `Input[${index}].Type`,
        cmdOption: `--cell-index ${index} --cell-type input --script-group-type type`,
      });
    }
  }

  for (const [index, output] of cccTx.outputs.entries()) {
    if (output.type) {
      result.push({
        name: `Output[${index}].Type`,
        cmdOption: `--cell-index ${index} --cell-type output --script-group-type type`,
      });
    }
  }

  return result;
}

export function debugSingleScript(
  txHash: string,
  cellIndex: number,
  cellType: 'input' | 'output',
  scriptType: 'type' | 'lock',
  network: Network,
  bin?: string,
) {
  const txFile = buildTxFileOptionBy(txHash, network);
  let opt = `--cell-index ${cellIndex} --cell-type ${cellType} --script-group-type ${scriptType}`;
  if (bin) {
    opt = opt + ` --bin ${bin}`;
  }
  debugRaw(`${txFile} ${opt}`);
}

// Helper function to validate and parse the --script value
export function parseSingleScriptOption(value: string) {
  const regex = /^(input|output)\[(\d+)\]\.(lock|type)$/i;
  const match = value.match(regex);

  if (!match) {
    throw new Error(`Invalid --script value: ${value}, example format: "input[0].lock"`);
  }

  const [_, cellType, cellIndex, scriptType] = match;
  return {
    cellType: cellType.toLowerCase() as 'input' | 'output', // input or output
    cellIndex: parseInt(cellIndex, 10), // number in []
    scriptType: scriptType.toLowerCase() as 'type' | 'lock', // lock or type
  };
}

export function buildTxFileOptionBy(txHash: string, network: Network) {
  const settings = readSettings();
  const outputFilePath = buildDebugFullTransactionFilePath(network, txHash);
  if (!fs.existsSync(outputFilePath)) {
    const rpc = settings.devnet.rpcUrl;
    const txJsonFilePath = buildTransactionJsonFilePath(network, txHash);
    if (!fs.existsSync(outputFilePath)) {
      fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    }
    dumpTransaction({ rpc, txJsonFilePath, outputFilePath });
  }
  const opt = `--tx-file ${encodeBinPathForTerminal(outputFilePath)}`;
  return opt;
}

export function buildTransactionJsonFilePath(network: Network, txHash: string) {
  const settings = readSettings();
  if (network === Network.devnet) {
    return `${settings.devnet.transactionsPath}/${txHash}.json`;
  }
  if (network === Network.testnet) {
    return `${settings.testnet.transactionsPath}/${txHash}.json`;
  }
  return `${settings.mainnet.transactionsPath}/${txHash}.json`;
}

export function buildDebugFullTransactionFilePath(network: Network, txHash: string) {
  const settings = readSettings();
  if (network === Network.devnet) {
    return `${settings.devnet.debugFullTransactionsPath}/${txHash}.json`;
  }
  if (network === Network.testnet) {
    return `${settings.testnet.debugFullTransactionsPath}/${txHash}.json`;
  }
  return `${settings.mainnet.debugFullTransactionsPath}/${txHash}.json`;
}

export function debugRaw(options: string) {
  return CKBDebugger.runRaw(options);
}

export async function buildContract(jsFile: string, outputFile: string, jsVmPath?: string) {
  logger.info(`🔧 Building contract from ${jsFile} to ${outputFile}...`);

  try {
    // Find the ckb-js-vm binary path
    let ckbJsVmPath: string;

    // Use provided jsVmPath if available
    if (jsVmPath) {
      if (fs.existsSync(jsVmPath)) {
        ckbJsVmPath = jsVmPath;
      } else {
        throw new Error(`Provided ckb-js-vm path not found: ${jsVmPath}`);
      }
    } else {
      // First try to find in node_modules (for generated projects)
      const nodeModulesPath = 'node_modules/ckb-testtool/src/unittest/defaultScript/ckb-js-vm';
      if (fs.existsSync(nodeModulesPath)) {
        ckbJsVmPath = nodeModulesPath;
      } else {
        // Fallback to offckb's built-in ckb-js-vm (for development/testing)
        const offckbBuiltinPath = path.join(__dirname, '../../ckb/ckb-js-vm/build/ckb-js-vm');
        if (fs.existsSync(offckbBuiltinPath)) {
          ckbJsVmPath = offckbBuiltinPath;
        } else {
          throw new Error(
            'ckb-js-vm binary not found. Please ensure ckb-testtool is installed or build the offckb project.',
          );
        }
      }
    }

    logger.debug(`📍 Using ckb-js-vm from: ${ckbJsVmPath}`);

    // Use the CKBDebugger to compile JavaScript to bytecode
    const args = ['--read-file', jsFile, '--bin', ckbJsVmPath, '--', '-c', outputFile];

    await CKBDebugger.runWithArgs(args);
    logger.success(`✅ Contract built successfully: ${outputFile}`);
  } catch (error) {
    logger.error(`❌ Build failed: ${error}`);
    process.exit(1);
  }
}
