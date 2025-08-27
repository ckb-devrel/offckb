import { DeploymentOptions, generateDeploymentTomlInPath } from '../deploy/toml';
import {
  DeploymentRecipe,
  generateDeploymentMigrationFileInPath,
  getFormattedMigrationDate,
  Migration,
} from '../deploy/migration';
import { readFileToUint8Array, isAbsolutePath, getBinaryFilesFromPath } from '../util/fs';
import path from 'path';
import fs from 'fs';
import { Network } from '../type/base';
import { CKB } from '../sdk/ckb';
import { HexString } from '../type/base';
import { ccc } from '@ckb-ccc/core';
import { MyScriptsRecord } from '../scripts/type';
import { getScriptInfoFrom } from '../scripts/util';
import { generateScriptInfoJsonFile } from './script';
import { logger } from '../util/logger';

export type DeployBinaryReturnType = ReturnType<typeof deployBinary>;
export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
export type DeployedInterfaceType = UnwrapPromise<DeployBinaryReturnType>;

export function getToDeployBinsPath(userOffCKBConfigPath: string) {
  const fileContent = fs.readFileSync(userOffCKBConfigPath, 'utf-8');
  const match = fileContent.match(/contractBinFolder:\s*['"]([^'"]+)['"]/);
  if (match && match[1]) {
    const contractBinFolderValue = match[1];
    const folderPath = path.dirname(userOffCKBConfigPath);
    const binFileOrFolderPath = isAbsolutePath(contractBinFolderValue)
      ? contractBinFolderValue
      : path.resolve(folderPath, contractBinFolderValue);

    const bins = getBinaryFilesFromPath(binFileOrFolderPath);
    return bins;
  } else {
    logger.info('contractBinFolder value not found in offckb.config.ts');
    return [];
  }
}

export async function saveArtifacts(artifactsPath: string, results: DeployedInterfaceType[], network: Network) {
  if (results.length === 0) {
    logger.info('No artifacts to save.');
    return;
  }
  if (!fs.existsSync(artifactsPath)) {
    fs.mkdirSync(artifactsPath, { recursive: true });
  }
  const deployedScriptsInfo: MyScriptsRecord = {};
  for (const result of results) {
    logger.info(`Saving artifacts for ${result.deploymentOptions.name}...`);
    const tomlPath = path.join(artifactsPath, network, result.deploymentOptions.name, 'deployment.toml');
    generateDeploymentTomlInPath(result.deploymentOptions, tomlPath);
    const migrationPath = path.join(
      artifactsPath,
      network,
      result.deploymentOptions.name,
      'migrations',
      `${getFormattedMigrationDate()}.json`,
    );
    generateDeploymentMigrationFileInPath(result.deploymentRecipe, migrationPath);
    const { name, scriptsInfo } = getScriptInfoFrom(result.deploymentRecipe);
    deployedScriptsInfo[name] = scriptsInfo;
  }

  const scriptInfoFilePath = path.join(artifactsPath, 'scripts.json');
  generateScriptInfoJsonFile(network, deployedScriptsInfo, scriptInfoFilePath);
  logger.info(`Script info file ${scriptInfoFilePath} generated successfully.`);
}

export async function deployBinaries(binPaths: string[], privateKey: HexString, enableTypeId: boolean, ckb: CKB) {
  if (binPaths.length === 0) {
    logger.info('No binary to deploy.');
  }
  const results: DeployedInterfaceType[] = [];
  for (const bin of binPaths) {
    const result = await deployBinary(bin, privateKey, enableTypeId, ckb);
    results.push(result);
  }
  return results;
}

export async function deployBinary(
  binPath: string,
  privateKey: HexString,
  enableTypeId: boolean,
  ckb: CKB,
): Promise<{
  deploymentRecipe: DeploymentRecipe;
  deploymentOptions: DeploymentOptions;
}> {
  const bin = await readFileToUint8Array(binPath);
  const contractName = path.basename(binPath);

  const result = !enableTypeId
    ? await ckb.deployScript(bin, privateKey)
    : Migration.isDeployedWithTypeId(contractName, ckb.network)
      ? await ckb.upgradeTypeIdScript(contractName, bin, privateKey)
      : await ckb.deployNewTypeIDScript(bin, privateKey);

  logger.info(`contract ${contractName} deployed, tx hash:`, result.txHash);
  logger.info('wait for tx confirmed on-chain...');
  await ckb.waitForTxConfirm(result.txHash);
  logger.info('tx committed.');

  const txHash = result.txHash;
  const typeIdScript = result.typeId;
  const index = result.scriptOutputCellIndex;
  const tx = result.tx;
  const dataByteLen = BigInt(tx.outputsData[+index].slice(2).length / 2);
  const dataShannonLen = dataByteLen * BigInt('100000000');
  const occupiedCapacity = '0x' + dataShannonLen.toString(16);

  if (enableTypeId && typeIdScript == null) {
    throw new Error('type id script is null while enableTypeId is true.');
  }
  const typeIdScriptHash = enableTypeId ? ccc.Script.from(typeIdScript!).hash() : undefined;

  // todo: handle multiple cell recipes?
  return {
    deploymentOptions: {
      name: contractName,
      binFilePath: binPath,
      enableTypeId: enableTypeId,
      lockScript: tx.outputs[+index].lock,
    },
    deploymentRecipe: {
      cellRecipes: [
        {
          name: contractName,
          txHash,
          index: '0x' + index.toString(16),
          occupiedCapacity,
          dataHash: ccc.hashCkb(tx.outputsData[+index]),
          typeId: typeIdScriptHash,
        },
      ],
      depGroupRecipes: [],
    },
  };
}
