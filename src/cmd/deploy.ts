import { NetworkOption, Network } from '../type/base';
import path from 'path';
import { deployerAccount } from '../cfg/account';
import { isAbsolutePath, getBinaryFilesFromPath } from '../util/fs';
import { validateNetworkOpt } from '../util/validator';
import { deployBinaries, getToDeployBinsPath, recordDeployResult } from '../deploy';
import { CKB } from '../sdk/ckb';
import fs from 'fs';

export interface DeployOptions extends NetworkOption {
  target?: string;
  config?: string;
  privkey?: string | null;
  typeId?: boolean;
  proxyRpc?: boolean;
}

export async function deploy(
  opt: DeployOptions = { network: Network.devnet, typeId: false, target: undefined, proxyRpc: false },
) {
  const network = opt.network as Network;
  validateNetworkOpt(network);

  const isEnableProxyRpc = opt.proxyRpc;
  const ckb = new CKB({ network, isEnableProxyRpc });

  // we use deployerAccount to deploy contract by default
  const privateKey = opt.privkey || deployerAccount.privkey;
  const enableTypeId = opt.typeId ?? false;
  const configPath = opt.config;
  const targetFolder = opt.target;
  if (targetFolder) {
    const binFilesOrFolder = isAbsolutePath(targetFolder) ? targetFolder : path.resolve(process.cwd(), targetFolder);
    const binPaths = getBinaryFilesFromPath(binFilesOrFolder);
    const results = await deployBinaries(binPaths, privateKey, enableTypeId, ckb);

    // record the deployed contract infos
    recordDeployResult(results, network); // we don't update my-scripts.json since we don't know where the file is
    return;
  }

  // read contract bin folder
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
  const bins = getToDeployBinsPath(userOffCKBConfigPath);
  const results = await deployBinaries(bins, privateKey, enableTypeId, ckb);

  // record the deployed contract infos
  recordDeployResult(results, network, userOffCKBConfigPath);
}
