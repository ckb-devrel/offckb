import accountConfig from '../../account/account.json';
import { ckbDevnetMinerAccount } from '../cfg/account';
import { readSettings } from '../cfg/setting';
import { readForkState } from '../devnet/fork';
import { Network } from '../type/base';
import { logger } from './logger';

const BUILT_IN_DEV_KEYS = new Set(
  [...accountConfig.map((account) => account.privkey), ckbDevnetMinerAccount.privkey].map((key) => key.toLowerCase()),
);

export function warnIfMainnetForkSigning(network: Network, privateKey: string): void {
  if (network !== Network.devnet) return;

  const settings = readSettings();
  if (readForkState(settings.devnet.configPath)?.source !== 'mainnet') return;

  logger.warn([
    'MAINNET FORK REPLAY RISK: CKB transactions have no chain id.',
    'A transaction spending cells copied from Mainnet can also be valid on Mainnet.',
    'Use only built-in dev keys and fork-mined cells unless you explicitly accept that risk.',
  ]);
  if (!BUILT_IN_DEV_KEYS.has(privateKey.trim().toLowerCase())) {
    logger.warn('A non-built-in private key is being used on a Mainnet fork. Verify every input before signing.');
  }
}
