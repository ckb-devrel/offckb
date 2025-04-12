import { hexFrom, Transaction, hashTypeToBytes } from '@ckb-ccc/core';
import { readFileSync } from 'fs';
import { Resource, Verifier, DEFAULT_SCRIPT_ALWAYS_SUCCESS, DEFAULT_SCRIPT_CKB_JS_VM } from 'ckb-testtool';

async function main() {
  const resource = Resource.default();
  const tx = Transaction.default();

  const mainScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_CKB_JS_VM)), tx, false);
  const alwaysSuccessScript = resource.deployCell(hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
  const jsScript = resource.deployCell(hexFrom(readFileSync('../on-chain-script/dist/hello-world.bc')), tx, false);
  mainScript.args = hexFrom(
    '0x0000' +
      jsScript.codeHash.slice(2) +
      hexFrom(hashTypeToBytes(jsScript.hashType)).slice(2) +
      '0000000000000000000000000000000000000000000000000000000000000000',
  );
  // 1 input cell
  const inputCell = resource.mockCell(alwaysSuccessScript, mainScript, '0xFF000000000000000000000000000000');
  tx.inputs.push(Resource.createCellInput(inputCell));

  // 2 output cells
  tx.outputs.push(Resource.createCellOutput(alwaysSuccessScript, mainScript));
  tx.outputsData.push(hexFrom('0xFE000000000000000000000000000000'));
  tx.outputs.push(Resource.createCellOutput(alwaysSuccessScript, mainScript));
  tx.outputsData.push(hexFrom('0x01000000000000000000000000000000'));

  const verifier = Verifier.from(resource, tx);
  verifier.verifySuccess(true);
}

describe('unit test', () => {
  test('success', () => {
    main();
  });
});
