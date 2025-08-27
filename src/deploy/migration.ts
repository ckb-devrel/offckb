import { Network } from '../type/base';
import path, { dirname } from 'path';
import fs from 'fs';
import { getContractsPath } from './util';
import { HexNumber } from '../type/base';
import { logger } from '../util/logger';

export interface CellRecipe {
  name: string;
  txHash: string;
  index: HexNumber;
  occupiedCapacity: HexNumber;
  dataHash: string;
  typeId?: string;
}

export interface DepGroupRecipe {
  name: string;
  txHash: string;
  index: HexNumber;
  dataHash: string;
  occupiedCapacity: HexNumber;
}

export interface DeploymentRecipe {
  cellRecipes: CellRecipe[];
  depGroupRecipes: DepGroupRecipe[];
}

export interface MigrationJson {
  cell_recipes: {
    name: string;
    tx_hash: string;
    index: number;
    occupied_capacity: number; // CKB blocksize limit is 500k, so it should be impossible to have a cell occupied data larger than Number.MAX_SAFE_INTEGER which is 9007,1992,5474,0991
    data_hash: string;
    type_id?: string;
  }[];
  dep_group_recipes: {
    name: string;
    tx_hash: string;
    index: number;
    data_hash: string;
    occupied_capacity: number; // CKB blocksize limit is 500k, so it should be impossible to have a cell occupied data larger than Number.MAX_SAFE_INTEGER which is 9007,1992,5474,0991
  }[];
}

export class Migration {
  static find(scriptName: string, network: Network = Network.devnet) {
    const filePath = getMigrationFolderPath(scriptName, network);
    const migrationFile = getNewestMigrationFile(filePath);
    if (migrationFile == null) return null;

    return readDeploymentMigrationFile(migrationFile);
  }

  static isDeployed(scriptName: string, network: Network = Network.devnet) {
    const deploymentReceipt = Migration.find(scriptName, network);
    if (deploymentReceipt == null) return false;

    return true;
  }

  static isDeployedWithTypeId(scriptName: string, network: Network = Network.devnet) {
    const isDeployed = this.isDeployed(scriptName, network);
    if (isDeployed === false) return false;

    const deploymentReceipt = Migration.find(scriptName, network)!;
    const typeId = deploymentReceipt.cellRecipes[0].typeId;
    if (typeId == null) return false;

    return true;
  }
}

export function generateDeploymentMigrationFileInPath(deploymentRecipe: DeploymentRecipe, outputFilePath: string) {
  const cellRecipes = deploymentRecipe.cellRecipes;
  const depGroupRecipes = deploymentRecipe.depGroupRecipes;
  const jsonString = JSON.stringify(deploymentRecipeToJson({ cellRecipes, depGroupRecipes }), null, 2);
  if (!fs.existsSync(dirname(outputFilePath))) {
    fs.mkdirSync(dirname(outputFilePath), { recursive: true });
  }
  fs.writeFileSync(outputFilePath, jsonString);
  logger.info(`Migration json file ${outputFilePath} generated successfully.`);
}

export function generateDeploymentMigrationFile(
  name: string,
  deploymentRecipe: DeploymentRecipe,
  network = Network.devnet,
) {
  const outputFilePath: string = `${getContractsPath(network)}/${name}/migrations/${getFormattedMigrationDate()}.json`;
  return generateDeploymentMigrationFileInPath(deploymentRecipe, outputFilePath);
}

export function readDeploymentMigrationFile(filePath: string): DeploymentRecipe {
  const jsonString = fs.readFileSync(filePath, 'utf-8');
  const data: MigrationJson = JSON.parse(jsonString);
  return deploymentRecipeFromJson(data);
}

export function getFormattedMigrationDate(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are zero-based
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

export function getMigrationFolderPath(scriptName: string, network: Network) {
  const contractsPath = getContractsPath(network);
  return path.resolve(contractsPath, `${scriptName}/migrations`);
}

export function getNewestMigrationFile(folderPath: string): string | null {
  if (!fs.existsSync(folderPath) || !fs.lstatSync(folderPath).isDirectory()) {
    return null;
  }
  const files = fs
    .readdirSync(folderPath)
    .filter((file) => file.endsWith('.json')) // Ensure only JSON files are considered
    .sort((a, b) => {
      // Extract the timestamp part of the filename and compare them
      const timestampA = a.split('.json')[0];
      const timestampB = b.split('.json')[0];
      return timestampA.localeCompare(timestampB);
    });

  // Return the full path of the newest file (last in sorted array) or undefined if no files
  return files.length > 0 ? path.join(folderPath, files[files.length - 1]) : null;
}

export function deploymentRecipeToJson(recipe: DeploymentRecipe): MigrationJson {
  return {
    cell_recipes: recipe.cellRecipes.map((val) => {
      if (BigInt(val.occupiedCapacity) > BigInt(Number.MAX_SAFE_INTEGER)) {
        // CKB blocksize limit is 500k, so it should be impossible to have a cell occupied data larger than Number.MAX_SAFE_INTEGER which is 9007,1992,5474,0991
        logger.error(
          `invalid occupiedCapacity: ${val.occupiedCapacity}, the cell_recipes json might be incorrect for cell outpoint ${val.txHash}:${+val.index}`,
        );
      }
      return {
        name: val.name,
        tx_hash: val.txHash,
        index: +val.index,
        occupied_capacity: +BigInt(val.occupiedCapacity).toString(10),
        data_hash: val.dataHash,
        type_id: val.typeId,
      };
    }),
    dep_group_recipes: recipe.depGroupRecipes.map((val) => {
      if (BigInt(val.occupiedCapacity) > BigInt(Number.MAX_SAFE_INTEGER)) {
        // CKB blocksize limit is 500k, so it should be impossible to have a cell occupied data larger than Number.MAX_SAFE_INTEGER which is 9007,1992,5474,0991
        logger.error(
          `invalid occupiedCapacity: ${val.occupiedCapacity}, the dep_group_recipes json might be incorrect for cell outpoint ${val.txHash}:${+val.index}`,
        );
      }
      return {
        name: val.name,
        tx_hash: val.txHash,
        index: +val.index,
        data_hash: val.dataHash,
        occupied_capacity: +BigInt(val.occupiedCapacity).toString(10),
      };
    }),
  };
}

export function deploymentRecipeFromJson(json: MigrationJson): DeploymentRecipe {
  return {
    cellRecipes: json.cell_recipes.map((val) => {
      return {
        name: val.name,
        txHash: val.tx_hash,
        index: '0x' + val.index.toString(16),
        occupiedCapacity: '0x' + val.occupied_capacity.toString(16),
        dataHash: val.data_hash,
        typeId: val.type_id,
      };
    }),
    depGroupRecipes: json.dep_group_recipes.map((val) => {
      return {
        name: val.name,
        txHash: val.tx_hash,
        index: '0x' + val.index.toString(16),
        dataHash: val.data_hash,
        occupiedCapacity: '0x' + val.occupied_capacity.toString(16),
      };
    }),
  };
}
