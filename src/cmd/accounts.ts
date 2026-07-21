import accountConfig from '../../account/account.json';
import { ccc } from '@ckb-ccc/core';
import { readSettings } from '../cfg/setting';
import { readForkState } from '../devnet/fork';
import { warnIfForkIndexerIsBehind } from '../devnet/readiness';
import { Network } from '../type/base';
import { logger } from '../util/logger';

export interface AccountsOptions {
  showPrivateKeys?: boolean;
}

export async function accounts(options: AccountsOptions = {}) {
  const settings = readSettings();
  const fork = readForkState(settings.devnet.configPath);
  const isMainnetFork = fork?.source === 'mainnet';
  const client = isMainnetFork
    ? new ccc.ClientPublicMainnet({ url: settings.devnet.rpcUrl, fallbacks: [] })
    : new ccc.ClientPublicTestnet({ url: settings.devnet.rpcUrl, fallbacks: [] });
  const context = fork ? `DEVNET (fork of ${fork.source.toUpperCase()})` : 'DEVNET';
  const readiness = fork ? await warnIfForkIndexerIsBehind(Network.devnet) : undefined;
  const canReadSpendableBalance =
    readiness?.ready === true && readiness.indexerTip != null && readiness.indexerLag === BigInt(0);

  logger.warn([
    '#### All Accounts are for test and develop only  ####'.toUpperCase(),
    "#### DON'T use these accounts on Mainnet         ####".toUpperCase(),
    '#### Otherwise You will lose your money          ####'.toUpperCase(),
    '',
  ]);

  if (fork) {
    logger.info([
      `Print account list for ${context}. Addresses use the source-chain prefix.`,
      'Forked devnets do not include the standard offckb genesis allocation; funds come from fork-mined cellbase cells.',
      'Run `offckb devnet info` before trusting balances while the indexer catches up.',
      '',
    ]);
  } else {
    logger.info([
      'Print account list, each account is funded with 42_000_000_00000000 capacity in the devnet genesis block.',
      '',
    ]);
  }

  const resolvedAccounts = await Promise.all(
    accountConfig.map(async (account, index) => {
      const script = ccc.Script.from(account.lockScript as ccc.ScriptLike);
      const address = ccc.Address.fromScript(script, client).toString();
      const spendableCkb = canReadSpendableBalance
        ? ccc.fixedPointToString(await client.getBalanceSingle(script))
        : undefined;
      return {
        index,
        address,
        ...(spendableCkb == null ? {} : { spendableCkb }),
        ...(options.showPrivateKeys ? { privkey: account.privkey } : {}),
        pubkey: account.pubkey,
        lockArg: account.lockScript.args,
        lockScript: account.lockScript,
      };
    }),
  );

  const accountDetails = resolvedAccounts.map((account) => {
    return [
      `- "#": ${account.index}`,
      `address: ${account.address}`,
      ...('spendableCkb' in account ? [`spendable_ckb: ${account.spendableCkb}`] : []),
      ...(options.showPrivateKeys ? [`privkey: ${account.privkey}`] : []),
      `pubkey: ${account.pubkey}`,
      `lock_arg: ${account.lockArg}`,
      'lockScript:',
      `    codeHash: ${account.lockScript.codeHash}`,
      `    hashType: ${account.lockScript.hashType}`,
      `    args: ${account.lockScript.args}`,
      '',
    ];
  });

  accountDetails.forEach((details, _index) => {
    logger.info(details);
  });

  if (!options.showPrivateKeys) {
    logger.info('Private keys are hidden by default. Use --show-private-keys only in a trusted local terminal.');
  }
  logger.result({ command: 'accounts', context, forked: Boolean(fork), accounts: resolvedAccounts });
  return resolvedAccounts;
}
