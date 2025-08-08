#!/usr/bin/env node
import { Command } from 'commander';
import { node } from './cmd/node';
import { accounts } from './cmd/accounts';
import { clean } from './cmd/clean';
import { setUTF8EncodingForWindows } from './util/encoding';
import { DepositOptions, deposit } from './cmd/deposit';
import { DeployOptions, deploy } from './cmd/deploy';
import { TransferOptions, transfer } from './cmd/transfer';
import { BalanceOption, balanceOf } from './cmd/balance';
import { create, CreateOption, createScriptProject, createDAppProject } from './cmd/create';
import { Config, ConfigItem } from './cmd/config';
import { debugSingleScript, debugTransaction, parseSingleScriptOption } from './cmd/debug';
import { printSystemScripts } from './cmd/system-scripts';
import { transferAll } from './cmd/transfer-all';
import { genSystemScriptsJsonFile } from './scripts/gen';

const version = require('../package.json').version;
const description = require('../package.json').description;

// fix windows terminal encoding of simplified chinese text
setUTF8EncodingForWindows();

const program = new Command();
program.name('offckb').description(description).version(version);

program
  .command('create [your-project-name]')
  .description('Create a new dApp from bare templates')
  .option('-s, --script', 'Only create the script project')
  .option('-d, --dapp', 'Only create the ccc dapp project')
  .action(async (projectName: string, option: CreateOption) => {
    const name = projectName ?? 'my-first-ckb-project';
    if (option.script) {
      return await createScriptProject(name);
    }

    if (option.dapp) {
      return await createDAppProject(name);
    }

    return create(name);
  });

program
  .command('node [CKB-Version]')
  .description('Use the CKB to start devnet')
  .action(async (version: string) => {
    return node({ version });
  });

program.command('clean').description('Clean the devnet data, need to stop running the chain first').action(clean);
program.command('accounts').description('Print account list info').action(accounts);

program
  .command('deposit [toAddress] [amountInCKB]')
  .description('Deposit CKB tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to deposit to', 'devnet')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, amountInCKB: string, options: DepositOptions) => {
    return deposit(toAddress, amountInCKB, options);
  });

program
  .command('transfer [toAddress] [amountInCKB]')
  .description('Transfer CKB tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to transfer to', 'devnet')
  .option('--privkey <privkey>', 'Specify the private key to transfer CKB')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, amountInCKB: string, options: TransferOptions) => {
    return transfer(toAddress, amountInCKB, options);
  });

program
  .command('transfer-all [toAddress]')
  .description('Transfer All CKB tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to transfer to', 'devnet')
  .option('--privkey <privkey>', 'Specify the private key to deploy scripts')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, options: TransferOptions) => {
    return transferAll(toAddress, options);
  });

program
  .command('balance [toAddress]')
  .description('Check account balance, only devnet and testnet')
  .option('--network <network>', 'Specify the network to check', 'devnet')
  .action(async (toAddress: string, options: BalanceOption) => {
    return balanceOf(toAddress, options);
  });

program
  .command('deploy')
  .description('Deploy contracts to different networks, only supports devnet and testnet')
  .option('--network <network>', 'Specify the network to deploy to', 'devnet')
  .option('--target <target>', 'Specify the script binaries file/folder path to deploy', './')
  .option('-o, --output <output>', 'Specify the output folder path for the deployment record files', './deployment')
  .option('-t, --type-id', 'Specify if use upgradable type id to deploy the script')
  .option('--privkey <privkey>', 'Specify the private key to deploy scripts')
  .action((options: DeployOptions) => deploy(options));

program
  .command('config <action> [item] [value]')
  .description('do a configuration action')
  .action((action, item, value) => Config(action, item as ConfigItem, value));

program
  .command('debug')
  .requiredOption('--tx-hash <txHash>', 'Specify the transaction hash to debug with')
  .option('--single-script <singleScript>', 'Specify the cell script to debug with')
  .option('--bin <bin>', 'Specify a binary to replace the script to debug with')
  .option('--network <network>', 'Specify the network to debug', 'devnet')
  .description('CKB Debugger for development')
  .action(async (option) => {
    const txHash = option.txHash;
    if (option.singleScript) {
      const { cellType, cellIndex, scriptType } = parseSingleScriptOption(option.singleScript);
      return debugSingleScript(txHash, cellIndex, cellType, scriptType, option.network, option.bin);
    }
    return debugTransaction(txHash, option.network);
  });

program
  .command('system-scripts')
  .option('--export-style <exportStyle>', 'Specify the export format, possible values are system, lumos and ccc.')
  .option('--network <network>', 'Specify the CKB blockchain network', 'devnet')
  .option(
    '-o, --output <output>',
    'Specify the output json file path for the system scripts, export-style and network will be ignored if output is specified',
  )
  .description('Print/Output system scripts of the CKB blockchain')
  .action(async (option) => {
    const network = option.network;
    const exportStyle = option.exportStyle;
    if (option.output) {
      await genSystemScriptsJsonFile(option.output);
      console.log(`File ${option.output} generated successfully.`);
      return;
    }
    return printSystemScripts({ style: exportStyle, network });
  });

program.parse(process.argv);

// If no command is specified, display help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
