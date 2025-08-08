import * as fs from 'fs';
import { getContractsPath } from '../deploy/util';
import {
  DeploymentRecipe,
  getMigrationFolderPath,
  getNewestMigrationFile,
  readDeploymentMigrationFile,
} from '../deploy/migration';
import { MyScriptsRecord, ScriptInfo } from '../scripts/type';
import { getSubfolders } from '../util/fs';
import { Network } from '../type/base';
import path from 'path';

export function readDeployedScriptInfoFrom(contractDeploymentFolderPath: string) {
  const deployedScriptsInfo: MyScriptsRecord = {};

  // Read all files in the folder
  if (!fs.existsSync(contractDeploymentFolderPath)) {
    return deployedScriptsInfo;
  }

  const migrationFolderPath = path.resolve(contractDeploymentFolderPath, 'migrations');
  if (!fs.existsSync(migrationFolderPath)) {
    console.log(`No migrations folder found in ${migrationFolderPath}`);
    return deployedScriptsInfo;
  }

  const newestFilePath = getNewestMigrationFile(migrationFolderPath);
  if (!newestFilePath) {
    console.log(`No migration file found in ${migrationFolderPath}`);
    return deployedScriptsInfo;
  }

  try {
    // Read the file content
    const recipe = readDeploymentMigrationFile(newestFilePath);
    const { name, scriptsInfo } = getScriptInfoFrom(recipe);
    deployedScriptsInfo[name] = scriptsInfo;
  } catch (error) {
    console.error(`Error reading or parsing file '${newestFilePath}':`, error);
  }

  return deployedScriptsInfo;
}

export function getScriptInfoFrom(recipe: DeploymentRecipe) {
  // todo: handle multiple cell recipes?
  const firstCell = recipe.cellRecipes[0];
  const isDepCode = recipe.depGroupRecipes.length > 0;
  const scriptsInfo: ScriptInfo = {
    codeHash: (firstCell.typeId ? firstCell.typeId : firstCell.dataHash) as `0x${string}`,
    hashType: firstCell.typeId ? 'type' : 'data1',
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

export function readUserDeployedScriptsInfo(network: Network) {
  const deployedScriptsInfo: MyScriptsRecord = {};

  // Read all files in the folder
  const folder = getContractsPath(network);
  if (!fs.existsSync(folder)) {
    return deployedScriptsInfo;
  }

  const contractNames = getSubfolders(folder);
  for (const contractName of contractNames) {
    const folderPath = getMigrationFolderPath(contractName, network); // Replace with your function to get the folder path
    const newestFilePath = getNewestMigrationFile(folderPath);

    if (newestFilePath) {
      try {
        // Read the file content
        const recipe = readDeploymentMigrationFile(newestFilePath);
        // todo: handle multiple cell recipes?
        const firstCell = recipe.cellRecipes[0];
        const isDepCode = recipe.depGroupRecipes.length > 0;
        deployedScriptsInfo[firstCell.name] = {
          codeHash: (firstCell.typeId ? firstCell.typeId : firstCell.dataHash) as `0x${string}`,
          hashType: firstCell.typeId ? 'type' : 'data1',
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
      } catch (error) {
        console.error(`Error reading or parsing file '${newestFilePath}':`, error);
      }
    }
  }

  return deployedScriptsInfo;
}
