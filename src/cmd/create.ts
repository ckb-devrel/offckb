import path from 'path';
import { findFileInFolder } from '../util/fs';
import { injectConfig } from './inject-config';
import { confirm } from '@inquirer/prompts';
import { execSync } from 'child_process';
import { genMyScriptsJsonFile, genSystemScriptsJsonFile } from '../scripts/gen';
import { OffCKBConfigFile } from '../template/offckb-config';
const version = require('../../package.json').version;

export type ScriptOnly = {
  script: true;
  dapp?: false;
};

export type DappOnly = {
  dapp: true;
  script?: false;
};

export type CreateOption = ScriptOnly | DappOnly;

export function createScriptProject(name: string) {
  const cmd = `pnpm create ckb-js-vm-app ${name}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
  } catch (error: unknown) {
    console.error('create script project failed, ', (error as Error).message);
  }
}

export async function createDAppProject(name: string) {
  const cmd = `npx create-ccc-app@latest ${name} --ts --}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
    const dappFolderPath = path.resolve(process.cwd(), name);
    await askForInjectOffckbConfig(dappFolderPath);
  } catch (error: unknown) {
    console.error('create ccc-appp project failed, ', (error as Error).message);
  }
}

export async function createFullstackProject(name: string) {
  createScriptProject(name);
  console.log("Now let's create the dapp part..");
  const cmd = `pnpm create create-ccc-app@latest ${name}/packages/dapp --ts --}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
    const dappFolderPath = path.resolve(process.cwd(), name, 'packages', 'dapp');
    await askForInjectOffckbConfig(dappFolderPath);
    return dappFolderPath;
  } catch (error: unknown) {
    console.error('create fullstack appp project failed, ', (error as Error).message);
    process.exit(1);
  }
}

export async function create(name: string) {
  const dappFolderPath = await createFullstackProject(name);

  // update the version
  const targetConfigPath = findFileInFolder(dappFolderPath, 'offckb.config.ts');
  if (targetConfigPath) {
    OffCKBConfigFile.updateVersion(version, targetConfigPath);
    const contractInfoFolder = OffCKBConfigFile.readContractInfoFolder(targetConfigPath);
    if (!contractInfoFolder) {
      throw new Error('No contract info folder found in offckb.config.ts!');
    }

    const systemJsonFilePath = path.resolve(contractInfoFolder, 'system-scripts.json');
    genSystemScriptsJsonFile(systemJsonFilePath);

    const myScriptsJsonFilePath = path.resolve(contractInfoFolder, 'my-scripts.json');
    genMyScriptsJsonFile(myScriptsJsonFilePath);
  } else {
    console.log("Couldn't find the offckb config file in project. abort.");
  }
}

export async function askForInjectOffckbConfig(dappFolderPath: string) {
  const answer = await confirm({
    message: 'Do you want to inject offckb configs in your project  so that it can work with local blockchain info?',
  });
  if (answer) {
    const target = path.resolve(dappFolderPath, 'offckb.config.ts');
    injectConfig({ target });
  }
}
