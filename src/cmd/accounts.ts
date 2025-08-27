import accountConfig from '../../account/account.json';
import { logger } from '../util/logger';

export function accounts() {
  logger.warn([
    '#### All Accounts are for test and develop only  ####'.toUpperCase(),
    "#### DON'T use these accounts on Mainnet         ####".toUpperCase(),
    '#### Otherwise You will loose your money         ####'.toUpperCase(),
    '',
  ]);

  logger.info([
    'Print account list, each account is funded with 42_000_000_00000000 capacity in the devnet genesis block.',
    '',
  ]);

  const accountDetails = accountConfig.map((account, index) => {
    return [
      `- "#": ${index}`,
      `address: ${account.address}`,
      `privkey: ${account.privkey}`,
      `pubkey: ${account.pubkey}`,
      `lock_arg: ${account.lockScript.args}`,
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
}
