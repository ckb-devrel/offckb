import accountConfig from '../../account/account.json';
import { ckbDevnetMinerAccount } from '../cfg/account';
import { readSettings } from '../cfg/setting';
import { ForkState, readForkState } from '../devnet/fork';
import { Network } from '../type/base';
import { logger } from './logger';

const BUILT_IN_DEV_KEYS = new Set(
  [...accountConfig.map((account) => account.privkey), ckbDevnetMinerAccount.privkey].map((key) => key.toLowerCase()),
);

export function warnIfMainnetForkSigning(network: Network, privateKey: string): void {
  if (!readMainnetForkState(network)) return;

  logMainnetForkSigningWarning(privateKey);
}

/**
 * Fail closed before a Mainnet-fork transfer is constructed or signed.
 * Returns the copied-chain tip so the transaction layer can reject inputs
 * created at or before the fork boundary after input selection.
 */
export function validateMainnetForkSigning(
  network: Network,
  privateKey: string,
  allowMainnetReplayRisk = false,
): bigint | undefined {
  const fork = readMainnetForkState(network);
  if (!fork) return undefined;

  logMainnetForkSigningWarning(privateKey);
  if (!BUILT_IN_DEV_KEYS.has(privateKey.trim().toLowerCase()) && !allowMainnetReplayRisk) {
    throw new Error(
      'Refusing to sign with a non-built-in private key on a Mainnet fork. ' +
        'Use --allow-mainnet-replay-risk only after verifying that no copied Mainnet input will be selected.',
    );
  }
  if (fork.forkBlockNumber == null) {
    throw new Error(
      'Mainnet fork boundary metadata is missing. Restart or recreate the fork before signing so input origins can be verified.',
    );
  }
  try {
    return BigInt(fork.forkBlockNumber);
  } catch {
    throw new Error(`Invalid Mainnet fork boundary metadata: ${fork.forkBlockNumber}`);
  }
}

function readMainnetForkState(network: Network): ForkState | null {
  if (network !== Network.devnet) return null;
  const settings = readSettings();
  const fork = readForkState(settings.devnet.configPath);
  return fork?.source === 'mainnet' ? fork : null;
}

function logMainnetForkSigningWarning(privateKey: string): void {
  logger.warn([
    'MAINNET FORK REPLAY RISK: CKB transactions have no chain id.',
    'A transaction spending cells copied from Mainnet can also be valid on Mainnet.',
    'Use only built-in dev keys and fork-mined cells unless you explicitly accept that risk.',
  ]);
  if (!BUILT_IN_DEV_KEYS.has(privateKey.trim().toLowerCase())) {
    logger.warn('A non-built-in private key is being used on a Mainnet fork. Verify every input before signing.');
  }
}
