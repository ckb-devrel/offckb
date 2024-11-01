import path from 'path';
import { genMyScriptsJsonFile, genSystemScriptsJsonFile } from '../scripts/gen';
import { OffCKBConfigFile } from '../template/offckb-config';
import { isAbsolutePath } from '../util/fs';
import fs from 'fs';

export interface SyncScriptsProp {
  configPath?: string;
}

export function syncScripts({ configPath }: SyncScriptsProp) {
  const userOffCKBConfigPath = configPath
    ? isAbsolutePath(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath)
    : path.resolve(process.cwd(), 'offckb.config.ts');
  if (!fs.existsSync(userOffCKBConfigPath)) {
    throw new Error(
      `config file not exits: ${userOffCKBConfigPath}, tips: use --config to specific the offckb.config.ts file`,
    );
  }
  const contractInfoFolder = OffCKBConfigFile.readContractInfoFolder(userOffCKBConfigPath);
  if (!contractInfoFolder) {
    throw new Error('No contract info folder found in offckb.config.ts!');
  }

  const systemJsonFilePath = path.resolve(contractInfoFolder, 'system-scripts.json');
  genSystemScriptsJsonFile(systemJsonFilePath);

  const myScriptsJsonFilePath = path.resolve(contractInfoFolder, 'my-scripts.json');
  genMyScriptsJsonFile(myScriptsJsonFilePath);

  console.log('scripts json config updated.');
}
