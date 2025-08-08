import { NetworkOption, Network } from '../type/base';
import path from 'path';
import { deployerAccount } from '../cfg/account';
import { isAbsolutePath, getBinaryFilesFromPath, getBinaryFileSizeInBytes } from '../util/fs';
import { validateNetworkOpt } from '../util/validator';
import { deployBinaries, saveArtifacts } from '../deploy';
import { CKB } from '../sdk/ckb';
import { confirm } from '@inquirer/prompts';

export interface DeployOptions extends NetworkOption {
  target?: string;
  artifacts?: string;
  privkey?: string | null;
  typeId?: boolean;
}

export async function deploy(
  opt: DeployOptions = { network: Network.devnet, typeId: false, target: './', artifacts: './deployment' },
) {
  const network = opt.network as Network;
  validateNetworkOpt(network);

  // todo: enable proxy rpc for testnet and mainnet
  const ckb = new CKB({ network, isEnableProxyRpc: network === Network.devnet });

  // we use deployerAccount to deploy contract by default
  const privateKey = opt.privkey || deployerAccount.privkey;
  const enableTypeId = opt.typeId ?? false;
  const targetFolder = opt.target!;
  const artifactsFolder = opt.artifacts!;

  const binFilesOrFolder = isAbsolutePath(targetFolder) ? targetFolder : path.resolve(process.cwd(), targetFolder);
  let binPaths = getBinaryFilesFromPath(binFilesOrFolder);

  // ignore the binary file which is too large(> 500kb) to upload on chain
  binPaths = binPaths.filter((binPath) => {
    const size = getBinaryFileSizeInBytes(binPath);
    if (size > 500 * 1024) {
      console.warn(`[warning]: ignore deploying the binary file ${binPath} since its size is too large: ${size} bytes`);
      return false;
    }
    return true;
  });

  // ask user to confirm the deployment
  console.log('You are about to deploy the following contracts:');
  for (const binPath of binPaths) {
    console.log(`- ${binPath}`);
  }
  console.log(`\nThe deployment will be saved to ${artifactsFolder}`);
  console.log(`\nThe network is: ${network}`);

  const res = await confirm({
    message: 'Are you sure you want to deploy these contracts?',
  });

  if (!res) {
    console.log('Deployment cancelled.');
    return;
  }

  const results = await deployBinaries(binPaths, privateKey, enableTypeId, ckb);

  // record the deployed contract infos
  saveArtifacts(artifactsFolder, results, network);
}
