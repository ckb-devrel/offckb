import * as fs from 'fs';
import publicScripts from './public';
import { NetworkSystemScripts } from './type';
import path from 'path';
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
