// this is a rewrite for util/ckb.ts
// to replace lumos with ccc

import { ccc, ClientPublicMainnet, ClientPublicTestnet, OutPointLike, Script } from '@ckb-ccc/core';
import { isValidNetworkString } from '../util/validator';
import { networks } from './network';
import { buildCCCDevnetKnownScripts } from '../scripts/private';
import { Migration } from '../deploy/migration';
import { Network, HexNumber, HexString } from '../type/base';

export class CKBProps {
  network?: Network;
  feeRate?: number;
  isEnableProxyRpc?: boolean;
}

export interface DeploymentResult {
  txHash: HexString;
  tx: ccc.Transaction;
  scriptOutputCellIndex: number; // output cell index number of the deployed script
  isTypeId: boolean;
  typeId?: Script;
}

export interface TransferOption {
  privateKey: HexString;
  toAddress: string;
  amountInCKB: HexNumber;
}

export type TransferAllOption = Pick<TransferOption, 'privateKey' | 'toAddress'>;

export class CKB {
  public network: Network;
  public feeRate: number;
  public isEnableProxyRpc: boolean;
  private client: ClientPublicTestnet | ClientPublicMainnet;

  constructor({ network = Network.devnet, feeRate = 1000, isEnableProxyRpc = true }: CKBProps) {
    if (!isValidNetworkString(network)) {
      throw new Error('invalid network option');
    }

    this.network = network;
    this.feeRate = feeRate;
    this.isEnableProxyRpc = isEnableProxyRpc;

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

  buildSigner(privateKey: HexString) {
    const signer = new ccc.SignerCkbPrivateKey(this.client, privateKey);
    return signer;
  }

  async buildSecp256k1Address(privateKey: HexString) {
    const signer = this.buildSigner(privateKey);
    const address = await signer.getAddressObjSecp256k1();
    return address.toString();
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

  async waitForBlocksBy(interval: number) {
    if (interval < 0) throw new Error('interval must be number >= 0');

    const timeout = interval * 50000; // block interval is 18 secs, we set limit to 30s
    const tip = await this.client.getTip();
    const blockNum = tip + BigInt(interval);
    const query = async () => {
      const res = await this.client.getBlockByNumber(blockNum);
      if (res) {
        return true;
      } else {
        return false;
      }
    };
    return waitFor(query, timeout, 5000);
  }

  async balance(address: string): Promise<string> {
    const lock = (await ccc.Address.fromString(address, this.client)).script;
    const balanceInShannon = await this.client.getBalanceSingle(lock);
    const balanceInCKB = ccc.fixedPointToString(balanceInShannon);
    return balanceInCKB;
  }

  async transfer({ privateKey, toAddress, amountInCKB }: TransferOption): Promise<HexString> {
    const signer = this.buildSigner(privateKey);
    const to = await ccc.Address.fromString(toAddress, this.client);
    const tx = ccc.Transaction.from({
      outputs: [
        {
          capacity: ccc.fixedPointFrom(amountInCKB),
          lock: to.script,
        },
      ],
    });
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, this.feeRate);
    const txHash = await signer.sendTransaction(tx);
    return txHash;
  }

  async transferAll({ privateKey, toAddress }: TransferAllOption): Promise<HexString> {
    const signer = this.buildSigner(privateKey);
    const to = await ccc.Address.fromString(toAddress, this.client);
    const balanceInCKB = await this.balance((await signer.getRecommendedAddressObj()).toString());

    // leave 0.001 ckb for tx fee
    const amountInCKB = ccc.fixedPointFrom(balanceInCKB) - ccc.fixedPointFrom(0.001);
    const tx = ccc.Transaction.from({
      outputs: [
        {
          capacity: ccc.fixedPointFrom(amountInCKB),
          lock: to.script,
        },
      ],
    });
    await tx.completeInputsByCapacity(signer);
    const txHash = await signer.sendTransaction(tx);
    return txHash;
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
    await tx.completeFeeBy(signer, this.feeRate);
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
    await typeIdTx.completeFeeBy(signer, this.feeRate);
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
    await typeIdTx.completeFeeBy(signer, this.feeRate);
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
