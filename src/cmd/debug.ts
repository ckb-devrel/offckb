import { readSettings } from '../cfg/setting';
import { CKBDebugger } from '../tools/ckb-debugger';
import fs from 'fs';
import { dumpTransaction } from '../tools/ckb-tx-dumper';
import path from 'path';
import { cccA } from '@ckb-ccc/core/advanced';
import { Network } from '../type/base';
import { encodeBinPathForTerminal } from '../util/encoding';
import { callJsonRpc } from '../util/json-rpc';
import { logger } from '../util/logger';
import { validateTxHash } from '../util/validator';

export async function debugTransaction(txHash: string, network: Network) {
  validateTxHash(txHash);
  const txFile = await buildTxFileOptionBy(txHash, network);
  const opts = buildTransactionDebugOptions(txHash, network);
  for (const opt of opts) {
    logger.section(opt.name, [], 'info');
    debugRaw(`${txFile} ${opt.cmdOption}`);
  }
}

export function buildTransactionDebugOptions(txHash: string, network: Network) {
  validateTxHash(txHash);
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

export async function debugSingleScript(
  txHash: string,
  cellIndex: number,
  cellType: 'input' | 'output',
  scriptType: 'type' | 'lock',
  network: Network,
  bin?: string,
) {
  validateTxHash(txHash);
  const txFile = await buildTxFileOptionBy(txHash, network);
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

export async function buildTxFileOptionBy(txHash: string, network: Network) {
  // The hash is interpolated into cache file paths below; reject anything that
  // is not a plain 32-byte hash before touching the filesystem.
  validateTxHash(txHash);
  const settings = readSettings();
  const outputFilePath = buildDebugFullTransactionFilePath(network, txHash);
  if (!fs.existsSync(outputFilePath)) {
    const rpc = settings[network].rpcUrl;
    const txJsonFilePath = buildTransactionJsonFilePath(network, txHash);
    if (!fs.existsSync(txJsonFilePath)) {
      await fetchTransactionIntoCache(rpc, txHash, txJsonFilePath);
    }
    await dumpTransaction({ rpc, txJsonFilePath, outputFilePath });
  }
  const opt = `--tx-file ${encodeBinPathForTerminal(outputFilePath)}`;
  return opt;
}

// Fallback for transactions that never went through the local RPC proxy
// (e.g. historical transactions on a forked devnet): pull the transaction
// from the node and cache it in the same JSON-RPC format the proxy stores.
async function fetchTransactionIntoCache(rpc: string, txHash: string, txJsonFilePath: string) {
  logger.info(`Transaction ${txHash} not found in local cache, fetching from ${rpc} ..`);
  const result = await callJsonRpc(rpc, 'get_transaction', [txHash]).catch((error: Error) => {
    throw new Error(`Failed to fetch transaction ${txHash} from ${rpc}: ${error.message}`);
  });
  if (!result?.transaction) {
    throw new Error(
      `Transaction ${txHash} not found on ${rpc}. ` +
        `Check the hash and the --network option, or send the transaction through the offckb RPC proxy first.`,
    );
  }
  fs.mkdirSync(path.dirname(txJsonFilePath), { recursive: true });
  fs.writeFileSync(txJsonFilePath, JSON.stringify(result.transaction, null, 2));
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
    throw new Error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
