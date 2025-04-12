import { copyFileSync } from 'fs';
import path, { isAbsolute } from 'path';
import { genMyScriptsJsonFile, genSystemScriptsJsonFile } from '../scripts/gen';
import { OffCKBConfigFile } from '../template/offckb-config';
import { packageRootPath } from '../cfg/setting';
const version = require('../../package.json').version;

export interface InjectConfigProp {
  target?: string;
}

export function injectConfig({ target }: InjectConfigProp) {
  // inject the offckb.config.ts file into users workspace
  // copy config template
  const userOffCKBConfigPath = target
    ? isAbsolute(target)
      ? target
      : path.resolve(process.cwd(), target)
    : path.resolve(process.cwd(), 'offckb.config.ts');
  const predefinedOffCKBConfigTsPath = path.resolve(packageRootPath, 'templates/v3/offckb.config.example.ts');
  copyFileSync(predefinedOffCKBConfigTsPath, userOffCKBConfigPath);
  // update the version in the offckb.config.ts
  OffCKBConfigFile.updateVersion(version, userOffCKBConfigPath);

  const contractInfoFolder = OffCKBConfigFile.readContractInfoFolder(userOffCKBConfigPath);
  if (!contractInfoFolder) {
    throw new Error('No contract info folder found in offckb.config.ts!');
  }

  const systemJsonFilePath = path.resolve(contractInfoFolder, 'system-scripts.json');
  genSystemScriptsJsonFile(systemJsonFilePath);

  const myScriptsJsonFilePath = path.resolve(contractInfoFolder, 'my-scripts.json');
  genMyScriptsJsonFile(myScriptsJsonFilePath);

  console.log(`\n\nAll good. You can now use it in your project like: 
  
  import offCKB from "offckb.config";

  const myScriptCodeHash = offCKB.myScripts['script-name'].codeHash;
  const omnilockScriptCodeHash = offCKB.systemScripts['omnilock'].codeHash;

Check more on how to integrate offckb config to develop your app at https://docs.nervos.org/docs/getting-started/quick-start#different-frontend-framework
A Full example can also be found at https://github.com/nervosnetwork/docs.nervos.org/tree/develop/examples/simple-transfer
  `);
}
