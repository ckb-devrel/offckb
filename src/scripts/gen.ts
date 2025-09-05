import * as fs from 'fs';
import publicScripts from './public';
import { NetworkMyScripts, NetworkSystemScripts } from './type';
import path from 'path';
import { Network } from '../type/base';
import { readUserDeployedScriptsInfo } from './util';
import { isAbsolutePath } from '../util/fs';
import { getDevnetSystemScriptsFromListHashes } from './private';

export function genSystemScripts(): NetworkSystemScripts | null {
  const devnetScripts = getDevnetSystemScriptsFromListHashes();
  if (devnetScripts != null) {
    const networkScripts: NetworkSystemScripts = {
      devnet: devnetScripts,
      testnet: publicScripts.testnet,
      mainnet: publicScripts.mainnet,
    };
    return networkScripts;
  }
  return null;
}

export function genSystemScriptsJsonFile(filePath: string) {
  let outputFilePath = filePath;
  if (!isAbsolutePath(filePath)) {
    outputFilePath = path.resolve(process.cwd(), filePath);
  }
  const scripts = genSystemScripts();
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, JSON.stringify(scripts, null, 2));
}

export function genMyScripts(): NetworkMyScripts {
  const networkMyScripts: NetworkMyScripts = {
    devnet: readUserDeployedScriptsInfo(Network.devnet),
    testnet: readUserDeployedScriptsInfo(Network.testnet),
    mainnet: readUserDeployedScriptsInfo(Network.mainnet),
  };
  return networkMyScripts;
}

export function genMyScriptsJsonFile(filePath: string) {
  const scripts = genMyScripts();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(scripts, null, 2));
}
