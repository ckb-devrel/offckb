import fs from 'fs';
import path from 'path';
import { isFolderExists, copyFilesWithExclusion } from '../util/fs';
import { packageRootPath, readSettings } from '../cfg/setting';
import { logger } from '../util/logger';

export async function initChainIfNeeded() {
  const settings = readSettings();
  const devnetSourcePath = path.resolve(packageRootPath, './ckb/devnet');
  const devnetConfigPath = settings.devnet.configPath;
  const requiredConfigFiles = ['ckb.toml', 'ckb-miner.toml', path.join('specs', 'dev.toml')];
  const isInitialized =
    isFolderExists(devnetConfigPath) &&
    requiredConfigFiles.every((relativePath) => fs.existsSync(path.join(devnetConfigPath, relativePath)));
  const minerConfigPath = path.join(devnetConfigPath, 'ckb-miner.toml');
  const minerConfigWasMissing = !fs.existsSync(minerConfigPath);

  // Daemon mode creates data/logs before the child starts. A directory-only
  // check therefore mistakes a fresh install for an initialized chain. Check
  // the files CKB actually needs instead, and repair an incomplete directory.
  if (!isInitialized) {
    await copyFilesWithExclusion(devnetSourcePath, devnetConfigPath, ['data'], false);
    logger.debug(`init devnet config folder: ${devnetConfigPath}`);

    // copy and edit ckb-miner.toml
    const minerToml = path.join(devnetSourcePath, 'ckb-miner.toml');
    if (minerConfigWasMissing) {
      // Read the content of the ckb-miner.toml file
      const data = fs.readFileSync(minerToml, 'utf8');
      // Replace the URL
      const modifiedData = data.replace('http://ckb:8114/', settings.devnet.rpcUrl);
      // Write the modified content back to the file
      fs.writeFileSync(minerConfigPath, modifiedData, 'utf8');
    }
  }
}
