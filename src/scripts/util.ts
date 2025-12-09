import * as fs from 'fs';
import { DeploymentRecipe, getNewestMigrationFile, readDeploymentMigrationFile } from '../deploy/migration';
import { MyScriptsRecord, ScriptInfo } from '../scripts/type';
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
