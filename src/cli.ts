#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { startNode, stopNode } from './cmd/node';
import { accounts } from './cmd/accounts';
import { clean } from './cmd/clean';
import { setUTF8EncodingForWindows } from './util/encoding';
import { DepositOptions, deposit } from './cmd/deposit';
import { DeployOptions, deploy } from './cmd/deploy';
import { TransferOptions, transfer } from './cmd/transfer';
import { BalanceOption, balanceOf } from './cmd/balance';
import { udtIssue, udtDestroy, UdtIssueOption, UdtDestroyOption } from './cmd/udt';
import { createScriptProject, CreateScriptProjectOptions } from './cmd/create';
import { Config, ConfigItem } from './cmd/config';
import { devnetConfig } from './cmd/devnet-config';
import { devnetFork } from './cmd/devnet-fork';
import { devnetInfo } from './cmd/devnet-info';
import { debugSingleScript, debugTransaction, parseSingleScriptOption } from './cmd/debug';
import { printSystemScripts } from './cmd/system-scripts';
import { transferAll } from './cmd/transfer-all';
import { genSystemScriptsJsonFile } from './scripts/gen';
import { CKBDebugger } from './tools/ckb-debugger';
import { logger } from './util/logger';
import { Network } from './type/base';
import { status } from './cmd/status';

const version = require('../package.json').version;
const description = require('../package.json').description;

// fix windows terminal encoding of simplified chinese text
setUTF8EncodingForWindows();

const program = new Command();
program.name('offckb').description(description).version(version).enablePositionalOptions();
let activeCommand = 'offckb';

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join('.') || 'offckb';
}

program.option('--json', 'Output logs in JSON format for agent/programmatic consumption');
program.hook('preAction', (_thisCommand, actionCommand) => {
  activeCommand = commandPath(actionCommand);
  const opts = actionCommand.optsWithGlobals();
  if (opts.json) {
    logger.setJsonMode(true);
  }
});

const nodeCommand = program
  .command('node [CKB-Version]')
  .description('Use the CKB to start devnet')
  .option('--network <network>', 'Specify the network to deploy to', 'devnet')
  .option(
    '-b, --binary-path <binaryPath>',
    'Specify the CKB binary path to use, only for devnet, when set, will ignore version and network',
  )
  .option('--daemon', 'Run the node in the background as a daemon (devnet only)')
  .action(async (version: string, options: { network: Network; binaryPath?: string; daemon?: boolean }) => {
    return startNode({ version, network: options.network, binaryPath: options.binaryPath, daemon: options.daemon });
  });

nodeCommand
  .command('stop')
  .description('Stop the running CKB devnet daemon')
  .action(async () => stopNode());

program
  .command('create [project-name]')
  .description('Create a new CKB Smart Contract project in JavaScript.')
  .option('-m, --manager <manager>', 'Specify the package manager to use (npm, yarn, pnpm)')
  .option('-l, --language <language>', 'Specify the language to use (typescript, javascript)')
  .option('-c, --contract-name <name>', 'Specify the name for the first contract (default: hello-world)')
  .option('--no-interactive', 'Disable interactive prompts')
  .option('--no-install', 'Skip dependency installation')
  .option('--no-git', 'Skip git repository initialization')
  .action(async (projectName: string, options: CreateScriptProjectOptions) => {
    return await createScriptProject(projectName, options);
  });

program
  .command('deploy')
  .description('Deploy contracts to different networks, only supports devnet and testnet')
  .option('--network <network>', 'Specify the network to deploy to', 'devnet')
  .option('--target <target>', 'Specify the script binaries file/folder path to deploy', './')
  .option('-o, --output <output>', 'Specify the output folder path for the deployment record files', './deployment')
  .option('-t, --type-id', 'Specify if use upgradable type id to deploy the script')
  .option('--privkey <privkey>', 'Specify the private key to deploy scripts (visible in shell history)')
  .option('--privkey-file <path>', 'Read the private key from a local file')
  .option('-y, --yes', 'Skip confirmation prompt and deploy immediately')
  .action((options: DeployOptions) => deploy(options));

program
  .command('debug')
  .option('--tx-hash <txHash>', 'Specify the transaction hash to debug with')
  .option('--single-script <singleScript>', 'Specify the cell script to debug with')
  .option('--bin <bin>', 'Specify a binary to replace the script to debug with')
  .option('--network <network>', 'Specify the network to debug', 'devnet')
  .description('Quickly debug transaction with tx-hash')
  .action(async (option) => {
    // For debugging, tx-hash is required
    if (!option.txHash) {
      throw new Error('--tx-hash is required for debugging operations');
    }

    const txHash = option.txHash;
    if (option.singleScript) {
      const { cellType, cellIndex, scriptType } = parseSingleScriptOption(option.singleScript);
      return await debugSingleScript(txHash, cellIndex, cellType, scriptType, option.network, option.bin);
    }
    return await debugTransaction(txHash, option.network);
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
      logger.success(`File ${option.output} generated successfully.`);
      return;
    }
    return printSystemScripts({ style: exportStyle, network });
  });

program
  .command('clean')
  .description('Clean the devnet data, need to stop running the chain first')
  .option('-d, --data', 'Only remove chain data, keep devnet config files')
  .action((options: { data?: boolean }) => clean(options));
program
  .command('accounts')
  .description('Print account list info')
  .option('--show-private-keys', 'Include built-in dev private keys (hidden by default)')
  .action(async (options) => {
    await accounts(options);
  });

program
  .command('deposit [toAddress] [amountInCKB]')
  .description('Deposit CKB tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to deposit to', 'devnet')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, amountInCKB: string, options: DepositOptions) => {
    await deposit(toAddress, amountInCKB, options);
  });

program
  .command('transfer [toAddress] [amount]')
  .description('Transfer CKB or UDT tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to transfer to', 'devnet')
  .option('--privkey <privkey>', 'Specify the private key to transfer (visible in shell history)')
  .option('--privkey-file <path>', 'Read the private key from a local file')
  .addOption(new Option('--udt-kind <kind>', 'Specify the UDT kind').choices(['sudt', 'xudt']).default('sudt'))
  .option('--udt-type-args <typeArgs>', 'Specify the UDT type script args to transfer UDT')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, amount: string, options: TransferOptions) => {
    await transfer(toAddress, amount, options);
  });

program
  .command('transfer-all [toAddress]')
  .description('Transfer All CKB tokens to address, only devnet and testnet')
  .option('--network <network>', 'Specify the network to transfer to', 'devnet')
  .option('--privkey <privkey>', 'Specify the private key (visible in shell history)')
  .option('--privkey-file <path>', 'Read the private key from a local file')
  .option('-r, --proxy-rpc', 'Use Proxy RPC to connect to blockchain')
  .action(async (toAddress: string, options: TransferOptions) => {
    await transferAll(toAddress, options);
  });

program
  .command('balance [toAddress]')
  .description('Check account balance (CKB + detected SUDT/xUDT), only devnet and testnet')
  .option('--network <network>', 'Specify the network to check', 'devnet')
  .addOption(new Option('--udt-kind <kind>', 'Filter by UDT kind').choices(['sudt', 'xudt']))
  .option('--udt-type-args <typeArgs>', 'Filter by UDT type script args')
  .option('--no-udt', 'Skip UDT balance scan')
  .action(async (toAddress: string, options: BalanceOption) => {
    await balanceOf(toAddress, options);
  });

const udtCommand = program.command('udt').description('UDT token commands');

udtCommand
  .command('issue <amount>')
  .description('Issue new UDT tokens, only devnet and testnet')
  .option('--network <network>', 'Specify the network', 'devnet')
  .addOption(new Option('--udt-kind <kind>', 'Specify the UDT kind').choices(['sudt', 'xudt']).default('sudt'))
  .option('--type-args <typeArgs>', 'Specify the UDT type script args (xudt only; defaults to signer lock hash)')
  .option('--to <toAddress>', 'Specify the receiver address (defaults to signer)')
  .option('--privkey <privkey>', 'Specify the private key to issue UDT (visible in shell history)')
  .option('--privkey-file <path>', 'Read the private key from a local file')
  .action(async (amount: string, options: UdtIssueOption) => {
    await udtIssue(amount, options);
  });

udtCommand
  .command('destroy <amount>')
  .description('Destroy UDT tokens, only devnet and testnet')
  .option('--network <network>', 'Specify the network', 'devnet')
  .addOption(new Option('--udt-kind <kind>', 'Specify the UDT kind').choices(['sudt', 'xudt']).default('sudt'))
  .requiredOption('--type-args <typeArgs>', 'Specify the UDT type script args')
  .option('--privkey <privkey>', 'Specify the private key to destroy UDT (visible in shell history)')
  .option('--privkey-file <path>', 'Read the private key from a local file')
  .action(async (amount: string, options: UdtDestroyOption) => {
    await udtDestroy(amount, options);
  });

program
  .command('debugger')
  .description('Port of the raw CKB Standalone Debugger')
  .passThroughOptions()
  .allowUnknownOption()
  .helpOption(false) // Disable the default help option
  .action(async () => {
    return CKBDebugger.runWithArgs(process.argv.slice(2));
  });

program
  .command('status')
  .description('Show ckb-tui status interface')
  .addOption(
    new Option('--network <network>', 'Specify the network whose node status to monitor')
      .choices(['devnet', 'testnet', 'mainnet'])
      .default('devnet'),
  )
  .action(async (option) => {
    await status({ network: option.network });
  });

program
  .command('config <action> [item] [value]')
  .description('do a configuration action')
  .action((action, item, value) => Config(action, item as ConfigItem, value));

const devnetCommand = program.command('devnet').description('Devnet utility commands');

devnetCommand
  .command('config')
  .description('Open a full-screen editor to tweak devnet config files')
  .option(
    '-s, --set <key=value>',
    'Set a devnet config field non-interactively (repeatable), e.g. --set ckb.logger.filter=info',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .action(devnetConfig);

devnetCommand
  .command('info')
  .description('Show fork metadata and node/indexer readiness')
  .action(async () => {
    await devnetInfo();
  });

devnetCommand
  .command('fork')
  .description('Fork an existing mainnet/testnet chain data directory into the local devnet')
  .option('--from <dir>', 'Path to the source CKB node directory used with `ckb -C`')
  .option('--source <source>', 'Source chain: mainnet or testnet (auto-detected from the source ckb.toml when omitted)')
  .option('--spec-file <path>', 'Use a local chain spec file instead of downloading it')
  .option('--force', 'Replace the existing devnet (or a previous fork)')
  .option('--migrate', 'Migrate only the copied database when the selected CKB version requires it')
  .option('--dry-run', 'Run source/spec/database preflight without replacing the current devnet')
  .action(devnetFork);

function normalizeGlobalJsonFlag(argv: string[]): string[] {
  const jsonRequested = argv.slice(2).includes('--json');
  if (!jsonRequested) return argv;
  return [argv[0], argv[1], '--json', ...argv.slice(2).filter((arg) => arg !== '--json')];
}

function installBrokenPipeHandlers() {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        process.exit(0);
      }
      throw error;
    });
  }
}

function configureCommanderErrors(command: Command) {
  command.exitOverride();
  command.configureOutput({
    writeErr: (text) => {
      if (!logger.isJsonMode()) process.stderr.write(text);
    },
  });
  command.commands.forEach(configureCommanderErrors);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  installBrokenPipeHandlers();
  const normalizedArgv = normalizeGlobalJsonFlag(argv);
  if (normalizedArgv.includes('--json')) logger.setJsonMode(true);

  if (!normalizedArgv.slice(2).length) {
    program.outputHelp();
    return;
  }

  configureCommanderErrors(program);

  try {
    await program.parseAsync(normalizedArgv);
    if (logger.isJsonMode() && !logger.hasResult() && (process.exitCode == null || process.exitCode === 0)) {
      logger.result({ command: activeCommand, completed: true });
    }
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CommanderError ? error.code : 'COMMAND_FAILED';
    logger.failure(code, message);
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  }
}

if (require.main === module) {
  void runCli();
}
