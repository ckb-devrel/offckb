import fs from 'fs';
import path from 'path';
import { ccc } from '@ckb-ccc/core';
import { cccA } from '@ckb-ccc/core/advanced';
import { logger } from '../util/logger';

export interface DumpOption {
  rpc: string;
  txJsonFilePath: string;
  outputFilePath: string;
}

const OutPointCodec = ccc.mol.struct({
  txHash: ccc.mol.Byte32,
  index: ccc.mol.Uint32LE,
});

const OutPointVecCodec = ccc.mol.vector(OutPointCodec);

interface MockCellDep {
  cell_dep: {
    out_point: {
      tx_hash: string;
      index: string;
    };
    dep_type: string;
  };
  output: MockOutput;
  data: string;
}

interface MockInput {
  input: {
    previous_output: {
      tx_hash: string;
      index: string;
    };
    since: string;
  };
  output: MockOutput;
  data: string;
}

interface MockOutput {
  capacity: string;
  lock: MockScript;
  type: MockScript | null;
}

interface MockScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

interface MockTransaction {
  mock_info: {
    inputs: MockInput[];
    cell_deps: MockCellDep[];
    header_deps: string[];
  };
  tx: {
    version: string;
    cell_deps: {
      out_point: {
        tx_hash: string;
        index: string;
      };
      dep_type: string;
    }[];
    header_deps: string[];
    inputs: {
      previous_output: {
        tx_hash: string;
        index: string;
      };
      since: string;
    }[];
    outputs: MockOutput[];
    outputs_data: string[];
    witnesses: string[];
  };
}

function toMockScript(script: ccc.Script | undefined): MockScript | null {
  if (!script) return null;
  return {
    code_hash: script.codeHash,
    hash_type: script.hashType,
    args: script.args,
  };
}

function toDepType(depType: string): string {
  // Convert camelCase to snake_case for CKB JSON format
  if (depType === 'depGroup') return 'dep_group';
  return depType;
}

async function resolveCellDeps(client: ccc.Client, cellDeps: ccc.CellDep[]): Promise<MockCellDep[]> {
  const resolved: MockCellDep[] = [];

  for (const cellDep of cellDeps) {
    const cell = await client.getCell(cellDep.outPoint);
    if (!cell) {
      throw new Error(`Cell not found: ${JSON.stringify(cellDep.outPoint)}`);
    }

    if (cellDep.depType === 'depGroup') {
      resolved.push({
        cell_dep: {
          out_point: {
            tx_hash: cellDep.outPoint.txHash,
            index: '0x' + cellDep.outPoint.index.toString(16),
          },
          dep_type: toDepType(cellDep.depType),
        },
        output: {
          capacity: '0x' + cell.cellOutput.capacity.toString(16),
          lock: toMockScript(cell.cellOutput.lock)!,
          type: toMockScript(cell.cellOutput.type),
        },
        data: cell.outputData,
      });
      const data = cell.outputData;
      if (data && data !== '0x') {
        const outpoints = OutPointVecCodec.decode(data);
        for (const op of outpoints) {
          const outPoint = ccc.OutPoint.from({
            txHash: op.txHash,
            index: '0x' + op.index.toString(16),
          });
          const refCell = await client.getCell(outPoint);
          if (!refCell) {
            logger.error(
              `Failed to resolve cell for depGroup out_point: tx_hash=${outPoint.txHash}, index=${outPoint.index.toString()}`,
            );
            throw new Error('Failed to resolve all cells referenced by depGroup.');
          }
          resolved.push({
            cell_dep: {
              out_point: {
                tx_hash: outPoint.txHash,
                index: '0x' + outPoint.index.toString(16),
              },
              dep_type: 'code',
            },
            output: {
              capacity: '0x' + refCell.cellOutput.capacity.toString(16),
              lock: toMockScript(refCell.cellOutput.lock)!,
              type: toMockScript(refCell.cellOutput.type),
            },
            data: refCell.outputData,
          });
        }
      }
    } else {
      resolved.push({
        cell_dep: {
          out_point: {
            tx_hash: cellDep.outPoint.txHash,
            index: '0x' + cellDep.outPoint.index.toString(16),
          },
          dep_type: toDepType(cellDep.depType),
        },
        output: {
          capacity: '0x' + cell.cellOutput.capacity.toString(16),
          lock: toMockScript(cell.cellOutput.lock)!,
          type: toMockScript(cell.cellOutput.type),
        },
        data: cell.outputData,
      });
    }
  }

  return resolved;
}

async function resolveInputs(client: ccc.Client, inputs: ccc.CellInput[]): Promise<MockInput[]> {
  const resolved: MockInput[] = [];

  for (const input of inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (!cell) {
      throw new Error(`Input cell not found: ${JSON.stringify(input.previousOutput)}`);
    }

    resolved.push({
      input: {
        previous_output: {
          tx_hash: input.previousOutput.txHash,
          index: '0x' + input.previousOutput.index.toString(16),
        },
        since: '0x' + input.since.toString(16),
      },
      output: {
        capacity: '0x' + cell.cellOutput.capacity.toString(16),
        lock: toMockScript(cell.cellOutput.lock)!,
        type: toMockScript(cell.cellOutput.type),
      },
      data: cell.outputData,
    });
  }

  return resolved;
}

export async function dumpTransaction({ rpc, txJsonFilePath, outputFilePath }: DumpOption) {
  try {
    const isTestnet = /testnet/i.test(rpc);
    const client = isTestnet
      ? new ccc.ClientPublicTestnet({
          url: rpc,
          fallbacks: [],
        })
      : new ccc.ClientPublicMainnet({
          url: rpc,
          fallbacks: [],
        });

    const txJson = JSON.parse(fs.readFileSync(txJsonFilePath, 'utf-8'));
    const tx = cccA.JsonRpcTransformers.transactionTo(txJson);

    const [cell_deps, inputs] = await Promise.all([
      resolveCellDeps(client, tx.cellDeps),
      resolveInputs(client, tx.inputs),
    ]);

    const mockTx: MockTransaction = {
      mock_info: {
        inputs,
        cell_deps,
        header_deps: tx.headerDeps.map((h) => h.toString()),
      },
      tx: {
        version: '0x' + tx.version.toString(16),
        cell_deps: tx.cellDeps.map((dep) => ({
          out_point: {
            tx_hash: dep.outPoint.txHash,
            index: '0x' + dep.outPoint.index.toString(16),
          },
          dep_type: toDepType(dep.depType),
        })),
        header_deps: tx.headerDeps.map((h) => h.toString()),
        inputs: tx.inputs.map((input) => ({
          previous_output: {
            tx_hash: input.previousOutput.txHash,
            index: '0x' + input.previousOutput.index.toString(16),
          },
          since: '0x' + input.since.toString(16),
        })),
        outputs: tx.outputs.map((output) => ({
          capacity: '0x' + output.capacity.toString(16),
          lock: toMockScript(output.lock)!,
          type: toMockScript(output.type),
        })),
        outputs_data: tx.outputsData,
        witnesses: tx.witnesses.map((w) => w.toString()),
      },
    };

    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(outputFilePath, JSON.stringify(mockTx, null, 2));
    logger.debug('Dump transaction successfully');
  } catch (error: unknown) {
    logger.error('Failed to dump transaction:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
