import { forkDevnet, ForkOptions } from '../devnet/fork';
import { logger } from '../util/logger';

export async function devnetFork(options: ForkOptions) {
  if (options.source && options.source !== 'mainnet' && options.source !== 'testnet') {
    logger.error(`Invalid --source value: ${options.source}. Expected mainnet or testnet.`);
    process.exit(1);
  }

  try {
    await forkDevnet(options);
  } catch (error) {
    logger.error((error as Error).message);
    process.exit(1);
  }
}
