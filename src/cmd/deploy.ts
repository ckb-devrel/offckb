import { NetworkOption, Network } from '../type/base';
import path from 'path';
import { deployerAccount } from '../cfg/account';
import { isAbsolutePath, getBinaryFilesFromPath, getBinaryFileSizeInBytes } from '../util/fs';
import { validateNetworkOpt } from '../util/validator';
import { deployBinaries, saveArtifacts } from '../deploy';
import { CKB } from '../sdk/ckb';
import { confirm } from '@inquirer/prompts';
import { logger } from '../util/logger';
import { resolvePrivateKey } from '../util/private-key';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';
import { warnIfMainnetForkSigning } from '../util/fork-safety';

export interface DeployOptions extends NetworkOption {
  target?: string;
  output?: string;
  privkey?: string | null;
  privkeyFile?: string | null;
  typeId?: boolean;
  yes?: boolean;
}

export async function deploy(
  opt: DeployOptions = { network: Network.devnet, typeId: false, target: './', output: './deployment' },
) {
  const network = opt.network as Network;
  validateNetworkOpt(network);

  // we use deployerAccount to deploy contract by default
  const privateKey = resolvePrivateKey(opt, deployerAccount.privkey);
  warnIfMainnetForkSigning(network, privateKey);
  await warnIfForkIndexerIsBehind(network);
  const ckb = new CKB({ network });
  const enableTypeId = opt.typeId ?? false;
  const targetFolder = opt.target!;
  const output = opt.output!;

  const outputFolder = isAbsolutePath(output) ? output : path.resolve(process.cwd(), output);
  const binFilesOrFolder = isAbsolutePath(targetFolder) ? targetFolder : path.resolve(process.cwd(), targetFolder);
  let binPaths = getBinaryFilesFromPath(binFilesOrFolder);

  // ignore the binary file which is too large(> 500kb) to upload on chain
  binPaths = binPaths.filter((binPath) => {
    const size = getBinaryFileSizeInBytes(binPath);
    if (size > 500 * 1024) {
      logger.warn(`[warning]: ignore deploying the binary file ${binPath} since its size is too large: ${size} bytes`);
      return false;
    }
    return true;
  });

  // ask user to confirm the deployment
  const contractsList = binPaths.map((binPath) => `   📄 ${path.basename(binPath)}`);
  logger.info([
    `🚀 Preparing to deploy ${binPaths.length} contract(s):`,
    ...contractsList,
    '',
    `   📁 Deployment artifacts will be saved to: ${outputFolder}`,
    `   🌐 Network: ${network}`,
    `   🔑 Using ${opt.privkey || opt.privkeyFile || process.env.OFFCKB_PRIVATE_KEY ? 'custom' : 'default'} private key`,
    `   🔄 Type ID: ${enableTypeId ? 'enabled (upgradable)' : 'disabled (immutable)'}`,
  ]);

  // Skip confirmation if -y flag is provided
  if (!opt.yes) {
    const res = await confirm({
      message: 'Are you sure you want to deploy these contracts?',
    });

    if (!res) {
      logger.info('Deployment cancelled.');
      return;
    }
  }

  const results = await deployBinaries(outputFolder, binPaths, privateKey, enableTypeId, ckb);

  logger.info('');
  // record the deployed contract infos
  saveArtifacts(outputFolder, results, network);
}
