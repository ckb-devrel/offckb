import { forkDevnet, ForkOptions } from '../devnet/fork';

export async function devnetFork(options: ForkOptions) {
  if (options.source && options.source !== 'mainnet' && options.source !== 'testnet') {
    throw new Error(`Invalid --source value: ${options.source}. Expected mainnet or testnet.`);
  }
  await forkDevnet(options);
}
