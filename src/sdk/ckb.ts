// this is a rewrite for util/ckb.ts
// to replace lumos with ccc

import { ccc, ClientPublicMainnet, ClientPublicTestnet, OutPointLike, Script } from '@ckb-ccc/core';
import { isValidNetworkString, normalizePrivKey, validateUdtAmount, validateUdtTypeArgs } from '../util/validator';
import { networks } from './network';
import { buildDevnetCCCClient, getDevnetSystemScriptsFromListHashes } from '../scripts/private';
import { MAINNET_SYSTEM_SCRIPTS, TESTNET_SYSTEM_SCRIPTS } from '../scripts/public';
import { SystemScriptsRecord } from '../scripts/type';
import { Migration } from '../deploy/migration';
import { Network, HexNumber, HexString, UdtKind } from '../type/base';

export { UdtKind } from '../type/base';
import { logger } from '../util/logger';

const DEFAULT_UDT_SCAN_MAX_CELLS = 1000;
const DEFAULT_UDT_DESTROY_MAX_INPUT_CELLS = 100;

interface UdtScriptInfo {
  codeHash: HexString;
  hashType: string;
  cellDeps: ccc.CellDepInfoLike[];
}

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

export interface UdtTransferOption {
  privateKey: HexString;
  toAddress: string;
  amount: HexNumber;
  udtType: ccc.Script;
  kind: UdtKind;
}

export interface UdtIssueOption {
  privateKey: HexString;
  kind: UdtKind;
  amount: HexNumber;
  typeArgs?: HexString;
  toAddress?: string;
}

export interface UdtIssueResult {
  txHash: HexString;
  typeArgs: HexString;
  receiver: string;
}

export interface UdtDestroyOption {
  privateKey: HexString;
  kind: UdtKind;
  typeArgs: HexString;
  amount: HexNumber;
}

export interface UdtBalanceInfo {
  kind: UdtKind;
  codeHash: HexString;
  hashType: string;
  args: HexString;
  balance: string;
}

function readUdtBalance(outputData: string | ccc.HexLike): bigint | null {
  try {
    return BigInt(ccc.udtBalanceFrom(outputData));
  } catch {
    return null;
  }
}

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
          ? new ccc.ClientPublicMainnet({ url: networks.mainnet.proxy_rpc_url, fallbacks: [networks.mainnet.rpc_url] }) // we keep the fallbacks in case the proxy rpc is not started
          : network === 'testnet'
            ? new ccc.ClientPublicTestnet({
                url: networks.testnet.proxy_rpc_url,
                fallbacks: [networks.testnet.rpc_url],
              }) // we keep the fallbacks in case the proxy rpc is not started
            : buildDevnetCCCClient(networks.devnet.proxy_rpc_url, [networks.devnet.rpc_url]);
    } else {
      this.client =
        network === 'mainnet'
          ? new ccc.ClientPublicMainnet({
              url: networks.mainnet.rpc_url,
              fallbacks: [],
            }) // pass it to avoid using websocket and fallback RPCs
          : network === 'testnet'
            ? new ccc.ClientPublicTestnet({
                url: networks.testnet.rpc_url,
                fallbacks: [],
              }) // pass it to avoid using websocket and fallback RPCs
            : buildDevnetCCCClient(networks.devnet.rpc_url);
    }
  }

  buildSigner(privateKey: HexString) {
    const normalizedKey = normalizePrivKey(privateKey);
    const signer = new ccc.SignerCkbPrivateKey(this.client, normalizedKey);
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

  private getSystemScripts(): SystemScriptsRecord {
    if (this.network === Network.mainnet) {
      return MAINNET_SYSTEM_SCRIPTS;
    }
    if (this.network === Network.testnet) {
      return TESTNET_SYSTEM_SCRIPTS;
    }
    const scripts = getDevnetSystemScriptsFromListHashes();
    if (!scripts) {
      throw new Error(`Failed to load devnet system scripts`);
    }
    return scripts;
  }

  async buildUdtTypeScript(kind: UdtKind, args: HexString): Promise<ccc.Script> {
    if (kind === 'xudt') {
      return ccc.Script.fromKnownScript(this.client, ccc.KnownScript.XUdt, args);
    }

    const scriptInfo = await this.getUdtScriptInfo(kind);
    return ccc.Script.from({
      codeHash: scriptInfo.codeHash,
      hashType: scriptInfo.hashType,
      args,
    });
  }

  private async getUdtScriptInfo(kind: UdtKind): Promise<UdtScriptInfo> {
    if (kind === 'xudt') {
      return this.client.getKnownScript(ccc.KnownScript.XUdt);
    }

    const systemScripts = this.getSystemScripts();
    const sudtScript = systemScripts.sudt?.script;
    if (!sudtScript) {
      throw new Error(`SUDT script not found on ${this.network}`);
    }
    return sudtScript;
  }

  async detectUdtBalances(
    address: string,
    { maxCells = DEFAULT_UDT_SCAN_MAX_CELLS }: { maxCells?: number } = {},
  ): Promise<UdtBalanceInfo[]> {
    const lock = (await ccc.Address.fromString(address, this.client)).script;

    const sudtScriptInfo = await this.getUdtScriptInfo('sudt').catch(() => null);
    const xudtScriptInfo = await this.getUdtScriptInfo('xudt').catch(() => null);

    const balances = new Map<
      string,
      { kind: UdtKind; codeHash: HexString; hashType: string; args: HexString; balance: bigint }
    >();

    let scanned = 0;

    const scan = async (scriptInfo: UdtScriptInfo, kind: UdtKind) => {
      for await (const cell of this.client.findCells(
        {
          script: {
            codeHash: scriptInfo.codeHash,
            hashType: scriptInfo.hashType,
            args: '0x',
          },
          scriptType: 'type',
          scriptSearchMode: 'prefix',
          filter: { script: lock },
          withData: true,
        },
        'asc',
      )) {
        if (scanned >= maxCells) {
          logger.warn(`UDT balance scan stopped after ${maxCells} cells; balances may be incomplete`);
          break;
        }
        scanned++;

        const type = cell.cellOutput.type;
        if (!type) {
          continue;
        }

        const cellBalance = readUdtBalance(cell.outputData);
        if (cellBalance == null) {
          logger.debug(`Skipping corrupted UDT cell ${cell.outPoint?.txHash}:${cell.outPoint?.index}`);
          continue;
        }

        const key = `${kind}:${type.codeHash}:${type.hashType}:${type.args}`;
        const entry = balances.get(key);
        if (entry) {
          entry.balance += cellBalance;
        } else {
          balances.set(key, {
            kind,
            codeHash: type.codeHash as HexString,
            hashType: String(type.hashType),
            args: type.args as HexString,
            balance: cellBalance,
          });
        }
      }
    };

    if (sudtScriptInfo) {
      await scan(sudtScriptInfo, 'sudt');
    }
    if (xudtScriptInfo) {
      await scan(xudtScriptInfo, 'xudt');
    }

    return Array.from(balances.values()).map((item) => ({
      ...item,
      balance: item.balance.toString(),
    }));
  }

  async udtBalance(
    address: string,
    udtType: ccc.Script,
    { maxCells = DEFAULT_UDT_SCAN_MAX_CELLS }: { maxCells?: number } = {},
  ): Promise<string> {
    const lock = (await ccc.Address.fromString(address, this.client)).script;
    let balance = BigInt(0);
    let scanned = 0;
    for await (const cell of this.client.findCellsByLock(lock, udtType, true)) {
      scanned++;
      if (scanned > maxCells) {
        logger.warn(`UDT balance scan stopped after ${maxCells} cells; balances may be incomplete`);
        break;
      }
      const cellBalance = readUdtBalance(cell.outputData);
      if (cellBalance != null) {
        balance += cellBalance;
      }
    }
    return balance.toString();
  }

  async udtTransfer({ privateKey, toAddress, amount, udtType, kind }: UdtTransferOption): Promise<HexString> {
    const signer = this.buildSigner(privateKey);
    const to = await ccc.Address.fromString(toAddress, this.client);
    const amountBigInt = validateUdtAmount(amount);

    const outputsData = [ccc.hexFrom(ccc.numToBytes(amountBigInt, 16))];
    const tx = ccc.Transaction.from({
      outputs: [
        {
          lock: to.script,
          type: udtType,
          capacity: ccc.fixedPointFrom(0),
        },
      ],
      outputsData,
    });

    const scriptInfo = await this.getUdtScriptInfo(kind);
    tx.addCellDeps(scriptInfo.cellDeps.map((dep) => dep.cellDep));

    await tx.completeInputsByUdt(signer, udtType);

    const inputsUdtBalance = await tx.getInputsUdtBalance(this.client, udtType);
    const outputsUdtBalance = tx.getOutputsUdtBalance(udtType);
    const changeAmount = inputsUdtBalance - outputsUdtBalance;
    if (changeAmount > BigInt(0)) {
      const from = await signer.getAddressObjSecp256k1();
      tx.outputs.push(
        ccc.CellOutput.from(
          {
            lock: from.script,
            type: udtType,
            capacity: ccc.fixedPointFrom(0),
          },
          ccc.hexFrom(ccc.numToBytes(changeAmount, 16)),
        ),
      );
      tx.outputsData.push(ccc.hexFrom(ccc.numToBytes(changeAmount, 16)));
    }

    await tx.completeFeeBy(signer, this.feeRate);
    const txHash = await signer.sendTransaction(tx);
    return txHash;
  }

  async udtIssue({ privateKey, kind, amount, typeArgs, toAddress }: UdtIssueOption): Promise<UdtIssueResult> {
    const signer = this.buildSigner(privateKey);
    const signerAddress = await signer.getAddressObjSecp256k1();
    const to = toAddress ? await ccc.Address.fromString(toAddress, this.client) : signerAddress;
    const amountBigInt = validateUdtAmount(amount);

    let resolvedTypeArgs: HexString;
    if (kind === 'sudt') {
      if (typeArgs) {
        logger.warn('SUDT type args are derived from the issuer lock hash; --type-args is ignored');
      }
      const issuerLockHash = signerAddress.script.hash();
      resolvedTypeArgs = issuerLockHash as HexString;
    } else {
      if (typeArgs) {
        resolvedTypeArgs = validateUdtTypeArgs(kind, typeArgs);
      } else {
        const issuerLockHash = signerAddress.script.hash();
        resolvedTypeArgs = issuerLockHash as HexString;
      }
    }

    const udtType = await this.buildUdtTypeScript(kind, resolvedTypeArgs);

    const outputsData = [ccc.hexFrom(ccc.numToBytes(amountBigInt, 16))];
    const tx = ccc.Transaction.from({
      outputs: [
        {
          lock: to.script,
          type: udtType,
          capacity: ccc.fixedPointFrom(0),
        },
      ],
      outputsData,
    });

    const scriptInfo = await this.getUdtScriptInfo(kind);
    tx.addCellDeps(scriptInfo.cellDeps.map((dep) => dep.cellDep));

    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, this.feeRate);
    const txHash = await signer.sendTransaction(tx);
    return { txHash, typeArgs: resolvedTypeArgs, receiver: to.toString() };
  }

  async udtDestroy(
    { privateKey, kind, typeArgs, amount }: UdtDestroyOption,
    { maxInputCells = DEFAULT_UDT_DESTROY_MAX_INPUT_CELLS }: { maxInputCells?: number } = {},
  ): Promise<HexString> {
    const signer = this.buildSigner(privateKey);
    const from = await signer.getAddressObjSecp256k1();
    const validatedTypeArgs = validateUdtTypeArgs(kind, typeArgs);
    const udtType = await this.buildUdtTypeScript(kind, validatedTypeArgs);
    const destroyAmount = validateUdtAmount(amount);

    const cells: ccc.Cell[] = [];
    let totalBalance = BigInt(0);
    for await (const cell of this.client.findCellsByLock(from.script, udtType, true)) {
      if (cells.length >= maxInputCells) {
        throw new Error(`Too many UDT cells to destroy (limit: ${maxInputCells}); split into smaller operations`);
      }
      const cellBalance = readUdtBalance(cell.outputData);
      if (cellBalance == null) {
        continue;
      }
      cells.push(cell);
      totalBalance += cellBalance;
    }

    if (totalBalance < destroyAmount) {
      throw new Error(`Insufficient UDT balance: ${totalBalance} < ${destroyAmount}`);
    }

    if (destroyAmount === totalBalance) {
      throw new Error(
        'Destroying the entire UDT balance may be rejected by the UDT script. Leave at least 1 token or use a smaller amount.',
      );
    }

    const tx = ccc.Transaction.from({});
    for (const cell of cells) {
      tx.addInput({ previousOutput: cell.outPoint });
    }

    const remaining = totalBalance - destroyAmount;
    tx.addOutput(
      ccc.CellOutput.from(
        {
          lock: from.script,
          type: udtType,
          capacity: ccc.fixedPointFrom(0),
        },
        ccc.hexFrom(ccc.numToBytes(remaining, 16)),
      ),
      ccc.hexFrom(ccc.numToBytes(remaining, 16)),
    );

    const scriptInfo = await this.getUdtScriptInfo(kind);
    tx.addCellDeps(scriptInfo.cellDeps.map((dep) => dep.cellDep));

    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, this.feeRate);
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
    baseFolder: string,
    scriptName: string,
    newScriptBinBytes: Uint8Array,
    privateKey: HexString,
  ): Promise<DeploymentResult> {
    const deploymentReceipt = Migration.find(baseFolder, scriptName, this.network);
    if (deploymentReceipt == null) throw new Error("no migration file, can't be updated.");
    const outpoint: OutPointLike = {
      txHash: deploymentReceipt.cellRecipes[0].txHash,
      index: deploymentReceipt.cellRecipes[0].index,
    };
    const typeId = deploymentReceipt.cellRecipes[0].typeId;
    if (typeId == null) throw new Error("type id in migration file is null, can't be updated.");

    logger.info(`Existing Type-ID found:
- Type ID: ${typeId}
(Upgrade keeps the same type-id by consuming the old code Cell and creating a new one.)
`);
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
      logger.debug((error as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
