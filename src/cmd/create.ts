import path from 'path';
import { findFileInFolder } from '../util/fs';
import { gitCloneAndDownloadFolderSync } from '../util/git';
import { injectConfig } from './inject-config';
import { select, confirm } from '@inquirer/prompts';
import { execSync } from 'child_process';
import { genMyScriptsJsonFile, genSystemScriptsJsonFile } from '../scripts/gen';
import { readSettings } from '../cfg/setting';
import { BareTemplateOption, loadBareTemplateOpts } from '../template/option';
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
  const cmd = `cargo generate gh:cryptape/ckb-script-templates workspace --name ${name}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
  } catch (error: unknown) {
    console.error('create script project failed, ', (error as Error).message);
  }
}

export async function createDappProject(name: string) {
  const cmd = `npx create-ccc-app@latest ${name} --ts}`;
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
    const dappFolderPath = path.resolve(process.cwd(), name);
    await askForInjectOffckbConfig(dappFolderPath);
  } catch (error: unknown) {
    console.error('create ccc-appp project failed, ', (error as Error).message);
  }
}

export async function create(name: string, template: BareTemplateOption) {
  const targetPath = path.resolve(process.cwd(), name);
  const settings = readSettings();
  const dappTemplateFolderPath = `${settings.dappTemplate.gitFolder}/${template.value}`;
  gitCloneAndDownloadFolderSync(
    settings.dappTemplate.gitRepoUrl,
    settings.dappTemplate.gitBranch,
    dappTemplateFolderPath,
    targetPath,
  );

  // update the version
  const projectFolder = path.resolve(process.cwd(), name);
  const targetConfigPath = findFileInFolder(projectFolder, 'offckb.config.ts');
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

export async function selectBareTemplate() {
  const opts = await loadBareTemplateOpts();

  const answer = await select({
    message: 'Select a bare template',
    choices: opts.map((opt) => {
      return {
        name: opt.name,
        value: opt.value,
        description: `${opt.description}, \n[${opt.tag.toString()}]`,
      };
    }),
  });

  return opts.find((opt) => opt.value === answer)!;
}

export async function askForInjectOffckbConfig(target: string) {
  const answer = await confirm({
    message: 'Do you want to inject offckb configs in your project  so that it can work with local blockchain info?',
  });
  if (answer) {
    injectConfig({ target });
  }
}
