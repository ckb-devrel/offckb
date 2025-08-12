import path from 'path';
import { MyScriptsRecord, NetworkMyScripts } from '../scripts/type';
import { Network } from '../type/base';
import fs from 'fs';

export function generateScriptInfoJsonFile(network: Network, myScriptsRecord: MyScriptsRecord, outputFilePath: string) {
  let scripts: NetworkMyScripts = {
    devnet: {},
    testnet: {},
    mainnet: {},
  };

  // read the output file first if it exists
  if (fs.existsSync(outputFilePath)) {
    const existingScripts: NetworkMyScripts = JSON.parse(fs.readFileSync(outputFilePath, 'utf8')) as NetworkMyScripts;
    existingScripts[network] = myScriptsRecord;
    scripts = existingScripts;
  } else {
    scripts[network] = myScriptsRecord;
  }

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, JSON.stringify(scripts, null, 2));
}
