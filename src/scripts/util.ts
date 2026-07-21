import * as fs from 'fs';
import { DeploymentRecipe, getNewestMigrationFile, readDeploymentMigrationFile } from '../deploy/migration';
import { MyScriptsRecord, ScriptInfo } from '../scripts/type';
import { SystemCell } from '../util/list-hashes';
import path from 'path';
import { logger } from '../util/logger';

export function readDeployedScriptInfoFrom(contractDeploymentFolderPath: string) {
  const deployedScriptsInfo: MyScriptsRecord = {};

  // Read all files in the folder
  if (!fs.existsSync(contractDeploymentFolderPath)) {
    return deployedScriptsInfo;
  }

  const migrationFolderPath = path.resolve(contractDeploymentFolderPath, 'migrations');
  if (!fs.existsSync(migrationFolderPath)) {
    logger.debug(`No migrations folder found in ${migrationFolderPath}`);
    return deployedScriptsInfo;
  }

  const newestFilePath = getNewestMigrationFile(migrationFolderPath);
  if (!newestFilePath) {
    logger.debug(`No migration file found in ${migrationFolderPath}`);
    return deployedScriptsInfo;
  }

  try {
    // Read the file content
    const recipe = readDeploymentMigrationFile(newestFilePath);
    const { name, scriptsInfo } = getScriptInfoFrom(recipe);
    deployedScriptsInfo[name] = scriptsInfo;
  } catch (error) {
    logger.error([`Error reading or parsing file '${newestFilePath}':`, (error as Error).toString()]);
  }

  return deployedScriptsInfo;
}

export function getScriptInfoFrom(recipe: DeploymentRecipe) {
  // todo: handle multiple cell recipes?
  const firstCell = recipe.cellRecipes[0];
  const isDepCode = recipe.depGroupRecipes.length > 0;
  const scriptsInfo: ScriptInfo = {
    codeHash: (firstCell.typeId ? firstCell.typeId : firstCell.dataHash) as `0x${string}`,
    hashType: firstCell.typeId ? 'type' : 'data2',
    cellDeps: !isDepCode
      ? [
          {
            cellDep: {
              outPoint: {
                txHash: firstCell.txHash as `0x${string}`,
                index: +firstCell.index,
              },
              depType: 'code',
            },
          },
        ]
      : recipe.depGroupRecipes.map((depGroupRecipe) => {
          return {
            cellDep: {
              outPoint: {
                txHash: depGroupRecipe.txHash as `0x${string}`,
                index: +depGroupRecipe.index,
              },
              depType: 'depGroup',
            },
          };
        }),
  };
  return {
    name: firstCell.name,
    scriptsInfo,
  };
}

/**
 * Extracts the script name from a CKB list-hashes path string.
 * Handles both Bundled() and FileSystem() wrappers, and works with Unix and Windows path separators.
 *
 * @param pathString - The path string from CKB list-hashes output
 * @returns The extracted script name
 *
 * @example
 * extractScriptNameFromPath('Bundled(specs/cells/secp256k1_blake160_sighash_all)') // => 'secp256k1_blake160_sighash_all'
 * extractScriptNameFromPath('FileSystem(/Users/user/devnet/specs/anyone_can_pay)') // => 'anyone_can_pay'
 * extractScriptNameFromPath('FileSystem(C:\\Users\\user\\devnet\\specs\\anyone_can_pay)') // => 'anyone_can_pay'
 */
export function extractScriptNameFromPath(pathString: string): string {
  // Remove FileSystem(...) or Bundled(...) wrapper if present
  const wrapperMatch = pathString.match(/^(?:FileSystem|Bundled)\((.+)\)$/);
  if (wrapperMatch) {
    pathString = wrapperMatch[1];
  }

  // Use path.basename to extract the filename
  // This is robust and handles the platform's native path separator correctly
  // On Windows, it handles backslashes; on Unix, it handles forward slashes
  return path.basename(pathString);
}

export function systemCellToScriptInfo({
  cell,
  depType,
  depGroup,
  extraCellDeps,
}: {
  cell: SystemCell;
  depType: 'code' | 'depGroup';
  depGroup?: {
    txHash: string;
    index: number;
  };
  extraCellDeps?: ScriptInfo['cellDeps'];
}): ScriptInfo {
  // todo: we left the type in cellDepsInfo since it requires async fetching and
  // chain running to get the full type script of the type-id deps.
  // Also, in devnet there is no real need to auto upgrade the system scripts with type-id
  if (depType === 'code') {
    let cellDeps: ScriptInfo['cellDeps'] = [
      {
        cellDep: {
          outPoint: {
            txHash: cell.tx_hash as `0x${string}`,
            index: cell.index,
          },
          depType,
        },
      },
    ];
    if (extraCellDeps && extraCellDeps.length > 0) {
      cellDeps = [...extraCellDeps, ...cellDeps];
    }
    return {
      codeHash: (cell.type_hash || cell.data_hash) as `0x${string}`,
      hashType: cell.type_hash ? 'type' : 'data2',
      cellDeps,
    };
  }

  if (depType === 'depGroup') {
    if (!depGroup) {
      throw new Error('require depGroup info since the dep type is depGroup');
    }

    let cellDeps: ScriptInfo['cellDeps'] = [
      {
        cellDep: {
          outPoint: {
            txHash: depGroup!.txHash as `0x${string}`,
            index: depGroup!.index,
          },
          depType,
        },
      },
    ];
    if (extraCellDeps && extraCellDeps.length > 0) {
      cellDeps = [...extraCellDeps, ...cellDeps];
    }

    return {
      codeHash: (cell.type_hash || cell.data_hash) as `0x${string}`,
      hashType: cell.type_hash ? 'type' : 'data2',
      cellDeps,
    };
  }

  throw new Error(`unknown DepType ${depType}`);
}
