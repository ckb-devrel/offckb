import { NetworkOption, Network } from '../type/base';
import path from 'path';
import { deployerAccount } from '../cfg/account';
import { listBinaryFilesInFolder, isAbsolutePath } from '../util/fs';
import { validateNetworkOpt, validateExecDappEnvironment } from '../util/validator';
import { deployBinaries, getToDeployBinsPath, recordDeployResult } from '../deploy';
import { CKB } from '../sdk/ckb';

export interface DeployOptions extends NetworkOption {
  target: string | null | undefined;
  privkey?: string | null;
  typeId?: boolean;
  proxyRpc?: boolean;
}

export async function deploy(
  opt: DeployOptions = { network: Network.devnet, typeId: false, target: null, proxyRpc: false },
) {
  const network = opt.network as Network;
  validateNetworkOpt(network);

  const isEnableProxyRpc = opt.proxyRpc;
  const ckb = new CKB({ network, isEnableProxyRpc });

  // we use deployerAccount to deploy contract by default
  const privateKey = opt.privkey || deployerAccount.privkey;
  const enableTypeId = opt.typeId ?? false;
  const targetFolder = opt.target;
  if (targetFolder) {
    const binFolder = isAbsolutePath(targetFolder) ? targetFolder : path.resolve(process.cwd(), targetFolder);
    const bins = listBinaryFilesInFolder(binFolder);
    const binPaths = bins.map((bin) => path.resolve(binFolder, bin));
    const results = await deployBinaries(binPaths, privateKey, enableTypeId, ckb);

    // record the deployed contract infos
    recordDeployResult(results, network, false); // we don't update my-scripts.json since we don't know where the file is
    return;
  }

  // check if target workspace is valid
  try {
    validateExecDappEnvironment();
  } catch (error) {
    return console.debug('Not a valid offCKB dapp workspace.');
  }

  // read contract bin folder
  const bins = getToDeployBinsPath();
  const results = await deployBinaries(bins, privateKey, enableTypeId, ckb);

  // record the deployed contract infos
  recordDeployResult(results, network);
}
