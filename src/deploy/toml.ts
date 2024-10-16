import { Script } from '@ckb-lumos/lumos';
import fs from 'fs';
import toml, { JsonMap } from '@iarna/toml';
import { Network } from '../util/type';
import { dirname } from 'path';
import { getContractsPath } from './util';
import { HashType } from '@ckb-ccc/core';

export interface DeploymentOptions {
  name: string;
  binFilePath: string;
  enableTypeId: boolean;
  lockScript: Script;
}

export interface DeploymentToml {
  cells: {
    name: string;
    enable_type_id: boolean;
    location: {
      file: string;
    };
  }[];
  lock: {
    code_hash: string;
    args: string;
    hash_type: HashType;
  };
}

export function generateDeploymentToml(options: DeploymentOptions, network: Network) {
  const data: DeploymentToml = {
    cells: [
      {
        name: options.name,
        enable_type_id: options.enableTypeId,
        location: {
          file: options.binFilePath,
        },
      },
    ],
    lock: {
      code_hash: options.lockScript.codeHash,
      args: options.lockScript.args,
      hash_type: options.lockScript.hashType,
    },
  };

  const tomlString = toml.stringify(data as unknown as JsonMap);
  const outputFilePath: string = `${getContractsPath(network)}/${options.name}/deployment.toml`;
  if (outputFilePath) {
    if (!fs.existsSync(dirname(outputFilePath))) {
      fs.mkdirSync(dirname(outputFilePath), { recursive: true });
    }
    fs.writeFileSync(outputFilePath, tomlString);
    console.log(`${options.name} deployment.toml file ${outputFilePath} generated successfully.`);
  }
}

export function readDeploymentToml(scriptName: string, network: Network) {
  const filePath = `${getContractsPath(network)}/${scriptName}/deployment.toml`;
  const file = fs.readFileSync(filePath, 'utf-8');
  const data = toml.parse(file) as unknown as DeploymentToml;
  return {
    cells: [
      {
        name: data.cells[0].name as string,
        enableTypeId: data.cells[0].enable_type_id,
        location: {
          file: data.cells[0].location.file as string,
        },
      },
    ],
    lock: {
      codeHash: data.lock.code_hash as string,
      args: data.lock.args as string,
      hashType: data.lock.hash_type as string,
    },
  };
}
