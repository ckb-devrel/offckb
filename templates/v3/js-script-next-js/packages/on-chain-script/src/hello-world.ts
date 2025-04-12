import * as bindings from '@ckb-js-std/bindings';
import { Script, HighLevel, log } from '@ckb-js-std/core';

function main() {
  log.setLevel(log.LogLevel.Debug);
  let script = bindings.loadScript();
  log.debug(`raw current script: ${JSON.stringify(script)}`);
  return 0;
}

bindings.exit(main());
