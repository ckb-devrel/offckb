// this is a rewrite for util/ckb.ts
// to replace lumos with ccc

import { ccc, ClientPublicMainnet, ClientPublicTestnet, OutPointLike, Script } from '@ckb-ccc/core';
import { Network } from '../util/type';
import { isValidNetworkString } from '../util/validator';
import { networks } from './network';
import { buildCCCDevnetKnownScripts } from '../scripts/private';
import { HexString } from '@ckb-lumos/lumos';
import { Migration } from '../deploy/migration';

export class CKBProps {
  network?: Network;
  isEnableProxyRpc?: boolean;
}

export interface DeploymentResult {
  txHash: HexString;
  tx: ccc.Transaction;
  scriptOutputCellIndex: number; // output cell index number of the deployed script
  isTypeId: boolean;
  typeId?: Script;
}

export class CKB {
  public network: Network;
  private client: ClientPublicTestnet | ClientPublicMainnet;

  constructor({ network = Network.devnet, isEnableProxyRpc = false }: CKBProps) {
    if (!isValidNetworkString(network)) {
      throw new Error('invalid network option');
    }

    this.network = network;

    if (isEnableProxyRpc === true) {
      this.client =
        network === 'mainnet'
          ? new ccc.ClientPublicMainnet({ url: networks.mainnet.proxy_rpc_url })
          : network === 'testnet'
            ? new ccc.ClientPublicTestnet({ url: networks.testnet.proxy_rpc_url })
            : new ccc.ClientPublicTestnet({
                url: networks.devnet.proxy_rpc_url,
                scripts: buildCCCDevnetKnownScripts(),
              });
    } else {
      this.client =
        network === 'mainnet'
          ? new ccc.ClientPublicMainnet()
          : network === 'testnet'
            ? new ccc.ClientPublicTestnet()
            : new ccc.ClientPublicTestnet({
                url: networks.devnet.rpc_url,
                scripts: buildCCCDevnetKnownScripts(),
              });
    }
  }

  private buildSigner(privateKey: HexString) {
    const signer = new ccc.SignerCkbPrivateKey(this.client, privateKey);
    return signer;
  }

  async waitForTxConfirm(txHash: HexString, timeout: number = 60000) {
    const query = async () => {
      const res = await this.client.getTransactionNoCache(txHash);
      if (res && res.status === 'committed') {
        return true;
      } else {
        return false;
      }
    };
    return waitFor(query, timeout, 5000);
  }

  async deployScript(scriptBinBytes: Uint8Array, privateKey: string): Promise<DeploymentResult> {
    const signer = this.buildSigner(privateKey);
    const signerSecp256k1Address = await signer.getAddressObjSecp256k1();
    const tx = ccc.Transaction.from({
      outputs: [
        {
          lock: signerSecp256k1Address.script,
        },
      ],
      outputsData: [scriptBinBytes],
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, 1000);
    const txHash = await signer.sendTransaction(tx);
    return { txHash, tx, scriptOutputCellIndex: 0, isTypeId: false };
  }

  async deployNewTypeIDScript(scriptBinBytes: Uint8Array, privateKey: string): Promise<DeploymentResult> {
    const signer = this.buildSigner(privateKey);
    const signerSecp256k1Address = await signer.getAddressObjSecp256k1();
    const typeIdTx = ccc.Transaction.from({
      outputs: [
        {
          lock: signerSecp256k1Address.script,
          type: await ccc.Script.fromKnownScript(this.client, ccc.KnownScript.TypeId, '00'.repeat(32)),
        },
      ],
      outputsData: [scriptBinBytes],
    });
    await typeIdTx.completeInputsByCapacity(signer);
    if (!typeIdTx.outputs[0].type) {
      throw new Error('Unexpected disappeared output');
    }
    typeIdTx.outputs[0].type.args = ccc.hashTypeId(typeIdTx.inputs[0], 0);
    await typeIdTx.completeFeeBy(signer, 1000);
    const txHash = await signer.sendTransaction(typeIdTx);
    return { txHash, tx: typeIdTx, scriptOutputCellIndex: 0, isTypeId: true, typeId: typeIdTx.outputs[0].type };
  }

  async upgradeTypeIdScript(
    scriptName: string,
    newScriptBinBytes: Uint8Array,
    privateKey: HexString,
  ): Promise<DeploymentResult> {
    const deploymentReceipt = Migration.find(scriptName, this.network);
    if (deploymentReceipt == null) throw new Error("no migration file, can't be updated.");
    const outpoint: OutPointLike = {
      txHash: deploymentReceipt.cellRecipes[0].txHash,
      index: deploymentReceipt.cellRecipes[0].index,
    };
    const typeId = deploymentReceipt.cellRecipes[0].typeId;
    if (typeId == null) throw new Error("type id in migration file is null, can't be updated.");

    const cell = await this.client.getCell(outpoint);
    if (cell == null) {
      throw new Error('type id cell not found!');
    }

    const typeIdArgs = cell.cellOutput.type?.args;
    if (typeIdArgs == null) {
      throw new Error("type id args is null, can't be updated");
    }
    const typeIdFromLiveCell = ccc.Script.from(cell.cellOutput.type!).hash();

    if (typeId !== typeIdFromLiveCell) {
      throw new Error(
        `type id not matched! migration file type id: ${typeId}, live cell type id: ${typeIdFromLiveCell}`,
      );
    }

    const cellInput = ccc.CellInput.from({ previousOutput: cell.outPoint, since: 0 });
    const signer = this.buildSigner(privateKey);
    const signerSecp256k1Address = await signer.getAddressObjSecp256k1();
    const typeIdTx = ccc.Transaction.from({
      inputs: [cellInput],
      outputs: [
        {
          lock: signerSecp256k1Address.script,
          type: await ccc.Script.fromKnownScript(this.client, ccc.KnownScript.TypeId, '00'.repeat(32)),
        },
      ],
      outputsData: [newScriptBinBytes],
    });
    await typeIdTx.completeInputsByCapacity(signer);
    if (!typeIdTx.outputs[0].type) {
      throw new Error('Unexpected disappeared output');
    }
    typeIdTx.outputs[0].type.args = typeIdArgs as `0x{string}`;
    await typeIdTx.completeFeeBy(signer, 1000);
    const txHash = await signer.sendTransaction(typeIdTx);
    return { txHash, tx: typeIdTx, scriptOutputCellIndex: 0, isTypeId: true, typeId: typeIdTx.outputs[0].type };
  }
}

async function waitFor(query: () => Promise<boolean>, timeout: number, interval: number): Promise<void> {
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Operation timed out');
    }

    try {
      const result = await query();
      if (result) break;
    } catch (error: unknown) {
      console.debug((error as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}