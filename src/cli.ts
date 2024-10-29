#!/usr/bin/env node
import { Command } from 'commander';
import { printDevnetListHashes } from './cmd/list-hashes';
import { node } from './cmd/node';
import { accounts } from './cmd/accounts';
import { clean } from './cmd/clean';
import { setUTF8EncodingForWindows } from './util/encoding';
import { injectConfig } from './cmd/inject-config';
import { DepositOptions, deposit } from './cmd/deposit';
import { DeployOptions, deploy } from './cmd/deploy';
import { syncScripts } from './cmd/sync-scripts';
import { TransferOptions, transfer } from './cmd/transfer';
import { BalanceOption, balanceOf } from './cmd/balance';
import { create, selectBareTemplate, CreateOption, createScriptProject } from './cmd/create';
import { printMyScripts, DeployedScriptOption } from './cmd/my-scripts';
import { Config, ConfigItem } from './cmd/config';
import { debugSingleScript, debugTransaction, parseSingleScriptOption } from './cmd/debug';
import { printSystemScripts } from './cmd/system-scripts';
import { proxyRpc, ProxyRpcOptions } from './cmd/proxy-rpc';
import { molFiles, molSingleFile } from './cmd/mol';
import * as fs from 'fs';
import { transferAll } from './cmd/transfer-all';
import { repl } from './cmd/repl';

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
  .action(async (projectName: string, option: CreateOption) => {
    const name = projectName ?? 'my-first-ckb-project';
    if (option.script) {
      return await createScriptProject(name);
    }

    const template = await selectBareTemplate();
    return create(name, template);
  });

program
  .command('node [CKB-Version]')
  .description('Use the CKB to start devnet')
  .option('--no-proxy', 'Do not start the rpc proxy server', true)
  .action(async (version: string, options) => {
    // commander.js change our noProxy option to proxy
    return node({ version, noProxyServer: !options.proxy });
  });

program
  .command('proxy-rpc')
  .description('Start the rpc proxy server')
  .option('--ckb-rpc <ckbRpc>', 'Specify the ckb rpc address')
  .option('--port <port>', 'Specify the port to start the proxy server')
  .option('--network <network>', 'Specify the network to proxy')
  .action((options: ProxyRpcOptions) => {
    return proxyRpc(options);
  });

program.command('clean').description('Clean the devnet data, need to stop running the chain first').action(clean);
program.command('accounts').description('Print account list info').action(accounts);
program
  .command('list-hashes [CKB-Version]')
  .description('Use the CKB to list blockchain scripts hashes')
  .action(printDevnetListHashes);
program.command('inject-config').description('Add offckb.config.ts to your frontend workspace').action(injectConfig);
program.command('sync-scripts').description('Sync scripts json files in your frontend workspace').action(syncScripts);

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
  .option('--target <target>', 'Specify the relative bin target folder to deploy to')
  .option('-t, --type-id', 'Specify if use upgradable type id to deploy the script')
  .option('--privkey <privkey>', 'Specify the private key to deploy scripts')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action((options: DeployOptions) => deploy(options));

program
  .command('my-scripts')
  .description('Show deployed contracts info on different networks, only supports devnet and testnet')
  .option('--network <network>', 'Specify the network to deploy to', 'devnet')
  .action((options: DeployedScriptOption) => printMyScripts(options));

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
  .description('Output system scripts of the CKB blockchain')
  .action(async (option) => {
    const network = option.network;
    const exportStyle = option.exportStyle;
    return printSystemScripts({ style: exportStyle, network });
  });

program
  .command('mol')
  .requiredOption('--schema <schema>', 'Specify the scheme .mol file/folders to generate bindings')
  .option('--output <output>', 'Specify the output file/folder path')
  .option('--output-folder <output-folder>', 'Specify the output folder path, only valid when schema is a folder')
  .option('--lang <lang>', 'Specify the binding language, [ts, js, c, rs, go]', 'ts')
  .description('Generate CKB Moleculec binding code for development')
  .action(async (option) => {
    if (fs.statSync(option.schema).isDirectory()) {
      const outputFolderPath = option.outputFolder ?? './';
      return molFiles(option.schema, outputFolderPath, option.lang);
    }
    return molSingleFile(option.schema, option.output, option.lang);
  });

program
  .command('repl')
  .description('A custom Nodejs REPL environment bundle for CKB.')
  .option('--network <network>', 'Specify the network to deploy to', 'devnet')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(repl);

program.parse(process.argv);

// If no command is specified, display help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
