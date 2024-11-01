## OffCKB

[![npm](https://img.shields.io/npm/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![CI](https://github.com/retricsu/offckb/actions/workflows/node.js.yml/badge.svg)](https://github.com/retricsu/offckb/actions/workflows/node.js.yml)
[![npm](https://img.shields.io/npm/dt/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![npm](https://img.shields.io/npm/l/@offckb/cli.svg?maxAge=1000)](https://github.com/jeffijoe/@offckb/cli/blob/master/LICENSE.md)
[![node](https://img.shields.io/node/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)

CKB local development network for your first try.

- One-line command to start a devnet
- No docker required
- Pre-funded test accounts
- Built-in scripts like [Omnilock](https://github.com/cryptape/omnilock) and [Spore-contract](https://github.com/sporeprotocol/spore-contract)
- Multiple minimal dApp templates to learn and get your hands dirty

**Migrate from v0.2.x to v0.3.x:**

There are BREAKING CHANGES between v0.2.x and v0.3.x, make sure to read the [migration guide](/docs/migration.md) before upgrading.

## Table of Contents

- [OffCKB](#offckb)
- [Table of Contents](#table-of-contents)
- [Install](#install)
- [Usage](#usage)
- [Get started](#get-started)
  - [Running CKB](#running-ckb)
  - [List scripts info](#list-scripts-info)
  - [Tweak Devnet Config](#tweak-devnet-config)
  - [Create a full-stack Project](#create-a-full-stack-project)
  - [Create a script-only Project](#create-a-script-only-project)
  - [Build and Deploy a script](#build-and-deploy-a-script)
  - [Start the frontend project](#start-the-frontend-project)
  - [Debug a transaction](#debug-a-transaction)
  - [Generate Moleculec bindings](#generate-moleculec-bindings)
- [REPL Mode](#repl-mode)
  - [Start the OffCKB REPL](#start-the-offckb-repl)
  - [Build CKB transaction in REPL](#build-ckb-transaction-in-repl)
  - [Get balance in REPL](#get-balance-in-repl)
- [Config Setting](#config-setting)
  - [List All Settings](#list-all-settings)
  - [Set CKB version](#set-ckb-version)
  - [Set Network Proxy](#set-network-proxy)
- [Built-in scripts](#built-in-scripts)
- [Accounts](#accounts)
- [About CCC](#about-ccc)
- [FAQ](#faq)
- [Contributing](#contributing)

## Install

```sh
npm install -g @offckb/cli
```

_We recommend using [LTS](https://nodejs.org/en/download/package-manager) version of Node to run `offckb`_

## Usage

```sh
Usage: offckb [options] [command]

ckb development network for your first try

Options:
  -V, --version                                 output the version number
  -h, --help                                    display help for command

Commands:
  create [options] [your-project-name]          Create a new dApp from bare templates
  node [options] [CKB-Version]                  Use the CKB to start devnet
  proxy-rpc [options]                           Start the rpc proxy server
  clean                                         Clean the devnet data, need to stop running the chain first
  accounts                                      Print account list info
  list-hashes [CKB-Version]                     Use the CKB to list blockchain scripts hashes
  inject-config                                 Add offckb.config.ts to your frontend workspace
  sync-scripts                                  Sync scripts json files in your frontend workspace
  deposit [options] [toAddress] [amountInCKB]   Deposit CKB tokens to address, only devnet and testnet
  transfer [options] [toAddress] [amountInCKB]  Transfer CKB tokens to address, only devnet and testnet
  transfer-all [options] [toAddress]            Transfer All CKB tokens to address, only devnet and testnet
  balance [options] [toAddress]                 Check account balance, only devnet and testnet
  deploy [options]                              Deploy contracts to different networks, only supports devnet and testnet
  my-scripts [options]                          Show deployed contracts info on different networks, only supports devnet and testnet
  config <action> [item] [value]                do a configuration action
  debug [options]                               CKB Debugger for development
  system-scripts [options]                      Output system scripts of the local devnet
  mol [options]                                 Generate CKB Moleculec binding code for development
  repl [options]                                A custom Nodejs REPL environment bundle for CKB.
  help [command]                                display help for command
```

_Use `offckb [command] -h` to learn more about a specific command._

## Get started

### Running CKB

Start a local blockchain with the default CKB version:

```sh
offckb node
```

Or specify a CKB version:

```sh
offckb node 0.117.0
```

Or set the default CKB version:

```sh
offckb config set ckb-version 0.117.0
offckb node
```

Once you start the devnet, there is a RPC server running at `http://localhost:8114`. There is also a RPC proxy server running at `http://localhost:9000` which will proxy all the requests to the RPC server. The meaning of using a proxy RPC server is to record request and automatically dump failed transactions so you can debug them easily later.

The proxy server is optional, you can use the RPC server directly if you don't need a proxy:

```sh
offckb node --no-proxy
```

Or start the proxy server in a standalone terminal to better monitor the logs:

```sh
offckb proxy-rpc --ckb-rpc http://localhost:8114 --port 9000 --network devnet
```

### List scripts info

List all the predefined scripts for the local blockchain:

```sh
offckb system-scripts
```

Or export the scripts info to a lumos JSON file:

```sh
offckb system-scripts --export-style lumos
```

Or print the scripts info in a CCC style:

```sh
offckb system-scripts --export-style ccc
```

### Tweak Devnet Config

By default, offckb use a fixed devnet config for the local blockchain. You can tweak the config to customize the devnet:

First, start a default CKB devnet and locate your devnet folder

```sh
offckb node
# after starting, press ctrl-c to kill the node
# then get the config
offckb config list
```

Result:

```json
{
  "devnet": {
    "rpcUrl": "http://localhost:8114",
    "configPath": "~/Library/Application Support/offckb-nodejs/devnet",
    "dataPath": "~/Library/Application Support/offckb-nodejs/devnet/data"
  }
}
```

Pay attention to the `devnet.configPath` and `devnet.dataPath`. They are the ones we need.

1. `cd` into the `devnet.configPath`, this is the config folder for the local blockchain. Modify the config in the folder to better customize the devnet. For customization, see [Custom Devnet Setup](https://docs.nervos.org/docs/node/run-devnet-node#custom-devnet-setup) and [Configure CKB](https://github.com/nervosnetwork/ckb/blob/develop/docs/configure.md) for better explanation of the config files.
2. After modifications, remove everything in the `devnet.dataPath` folder. This will clean the chain data.
3. Restart local blockchain by running `offckb node`

Done.

### Create a full-stack Project

Create a new project from predefined boilerplates.

```sh
offckb create <your-project-name, eg:my-first-ckb-project>
```

The boilerplate can be targeting on different CKB networks. Check [README.md](https://github.com/nervosnetwork/docs.nervos.org/blob/develop/examples/remix-vite-template/readme.md) in the project to get started.

### Create a script-only Project

You can create a new script project without a frontend. This is useful when you only want to develop smart contracts for CKB.

```sh
offckb create <your-project-name> --script
```

Note: you need to have rust/cargo/cargo-generate/clang 16+ installed in your environment to use this command. offckb doesn't do anything really, it just call [ckb-script-template](https://github.com/cryptape/ckb-script-templates) to do all the magic.

### Build and Deploy a script

The fullstack boilerplate project is a monorepo, which contains a script project and a frontend project.

To build the script, in the root of the project, run:

```sh
make build
```

To deploy the script, cd into the frontend folder where the default `offckb.config.ts` file is located and run:

```sh
cd frontend && offckb deploy --network <devnet/testnet>
```

Or specific the `offckb.config.ts` file path for deploy command to locate:

```sh
offckb deploy --network <devnet/testnet> --config <file-path-to-your-offckb.config.ts-file>
```

Pass `--type-id` option if you want Scripts to be upgradable

```sh
cd frontend && offckb deploy --type-id --network <devnet/testnet>
```

Once the deployment is done, you can use the following command to check the deployed scripts:

```sh
offckb my-scripts --network <devnet/testnet>
```

Your deployed scripts will be also be listed in the `frontend/offckb/my-scripts` folder in your frontend project.

### Start the frontend project

To start the frontend project, cd into the frontend folder and run:

```sh
npm i & npm run dev
```

### Debug a transaction

If you are using the proxy RPC server, all the failed transactions will be dumped and recorded so you can debug them later.

Everytime you run a transaction, you can debug it with the transaction hash:

```sh
offckb debug <transaction-hash>
```

It will verify all the scripts in the transaction and print the detailed info in the terminal.

```sh
offckb debug --tx-hash 0x64c936ee78107450d49e57b7453dce9031ce68b056b2f1cdad5c2218ab7232ad
Dump transaction successfully

******************************
****** Input[0].Lock ******

hello, this is new add!
Hashed 1148 bytes in sighash_all
sighash_all = 5d9b2340738ee28729fc74eba35e6ef969878354fe556bd89d5b6f62642f6e50
event = {"pubkey":"45c41f21e1cf715fa6d9ca20b8e002a574db7bb49e96ee89834c66dac5446b7a","tags":[["ckb_sighash_all","5d9b2340738ee28729fc74eba35e6ef969878354fe556bd89d5b6f62642f6e50"]],"created_at":1725339769,"kind":23334,"content":"Signing a CKB transaction\n\nIMPORTANT: Please verify the integrity and authenticity of connected Nostr client before signing this message\n","id":"90af298075ac878901282e23ce35b24e584b7727bc545e149fc259875a23a7aa","sig":"b505e7d5b643d2e6b1f0e5581221bbfe3c37f17534715e51eecf5ff97a2e1b828a3d767eb712555c78a8736e9085b4960458014fa171d5d169a1b267b186d2f3"}
verify_signature costs 3654 k cycles
Run result: 0
Total cycles consumed: 4013717(3.8M)
Transfer cycles: 44947(43.9K), running cycles: 3968770(3.8M)

******************************
****** Output[0].Type ******

verify_signature costs 3654 k cycles
Run result: 0
Total cycles consumed: 3916670(3.7M)
Transfer cycles: 43162(42.2K), running cycles: 3873508(3.7M)
```

If you want to debug a single cell script in the transaction, you can use the following command:

```sh
offckb debug <transaction-hash> --single-script <single-cell-script-option>
```

The `single-cell-script-option` format is `<cell-type>[<cell-index>].<script-type>`, eg: `"input[0].lock"`

- `cell-type` could be `input` or `output`, refers to the cell type
- `cell-index` is the index of the cell in the transaction
- `script-type` could be `lock` or `type`, refers to the script type

Or you can replace the script with a binary file in your single cell script debug session:

```sh
offckb debug <transaction-hash> --single-script <single-cell-script-option> --bin <path/to/binary/file>
```

All the debug utils are borrowed from [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger/tree/develop/ckb-debugger).

### Generate Moleculec bindings

[Moleculec](https://github.com/nervosnetwork/molecule) is the official Serialization/Deserialization system for CKB smart contracts.

You will define your data structure in `.mol` file(schema), and generate the bindings for different programming languages to use in your development.

```sh
offckb mol --schema <path/to/mol/file> --output <path/to/output/file> --lang <lang>
```

The `lang` could be `ts`, `js`, `c`, `rs` and `go`.

If you have multiple `.mol` files, you can use a folder as the input and specify an output folder:

```sh
offckb mol --schema <path/to/mol/folder> --output-folder <path/to/output/folder> --lang <lang>
```

## REPL Mode

OffCKB pack a custom Nodejs REPL with built-in variables and functions to help you develop CKB right in the terminal with minimal effort. This is suitable for simple script testing task when you don't want to write long and serious codes.

### Start the OffCKB REPL

```sh
offckb repl --network <devnet/testnet/mainnet, default: devnet>

Welcome to OffCKB REPL!
[[ Default Network: devnet, enableProxyRPC: false ]]
Type 'help()' to learn how to use.
OffCKB > 
```

Type `help()` to learn about the built-in variables and functions:

```sh
OffCKB > help()

OffCKB Repl, a Nodejs REPL with CKB bundles.

Global Variables to use:
  - ccc, cccA, imported from CKB Javascript SDK CCC
  - client, a CCC client instance bundle with current network
  - Client, a Wrap of CCC client class, you can build new client with
     const myClient = Client.new('devnet' | 'testnet' | 'mainnet');
     // or
     const myClient = Client.fromUrl('<your rpc url>', 'devnet' | 'testnet' | 'mainnet');
  - accounts, test accounts array from OffCKB
  - networks, network information configs
  - help, print this help message
```

### Build CKB transaction in REPL

```sh
OffCKB > let amountInCKB = ccc.fixedPointFrom(63);
OffCKB > let tx = ccc.Transaction.from({
...   outputs: [
...     {
...       capacity: ccc.fixedPointFrom(amountInCKB),
...       lock: accounts[0].lockScript,
...     },
...   ],
... });
OffCKB > let signer = new ccc.SignerCkbPrivateKey(client, accounts[0].privkey);
OffCKB > await tx.completeInputsByCapacity(signer);
2
OffCKB > await tx.completeFeeBy(signer, 1000);
[ 0, true ]
OffCKB > await mySigner.sendTransaction(tx)
'0x50fbfa8c47907d6842a325e85e48d5da6917e16ca7e2253ec3bd5bcdf8da99ce'
```

### Get balance in REPL

```sh
OffCKB > let myClient = Client.fromUrl(networks.testnet.rpc_url, 'testnet');
OffCKB > await myClient.getBalanceSingle(accounts[0].lockScript);
60838485293944n
OffCKB > 
```

## Config Setting

### List All Settings

```sh
offckb config list
```

### Set CKB version

```sh
offckb config get ckb-version
> 0.113.0
offckb config set ckb-version 0.117.0
offckb config get ckb-version
> 0.117.0
```

### Set Network Proxy

```sh
offckb config set proxy http://127.0.0.1:1086
> save new settings
offckb config get proxy
> http://127.0.0.1:1086
offckb config rm proxy
> save new settings
offckb config get proxy
> No Proxy.
```

## Built-in scripts

- [x] xUDT https://github.com/nervosnetwork/rfcs/pull/428
  - commit id: 410b16c
- [x] Omnilock https://github.com/cryptape/omnilock
  - commit id: cd764d7
- [x] AnyoneCanPay https://github.com/cryptape/anyone-can-pay
  - commit id: b845b3b
- [x] AlwaysSuccess https://github.com/nervosnetwork/ckb-production-scripts/blob/master/c/always_success.c
  - commit id: 410b16c
- [x] Spore https://github.com/sporeprotocol/spore-contract
  - version: 0.2.2-beta.1

## Accounts

`offckb` comes with 20 accounts, each account is funded with 42_000_000_00000000 capacity in the genesis block.

all the private keys are recorded in the `account/keys` file.
detail informations about each account are recorded in the `account/account.json` file.

:warning: **DO NOT SEND REAL ASSETS INTO ALL THESE ACCOUNTS, YOU CAN LOOSE YOUR MONEY** :warning:

## About CCC

`offckb` uses [CCC](https://github.com/ckb-devrel/ccc) as the development framework to build the CKB dApp template projects.

## FAQ

Sometimes you might encounter sudo permission problems. Granting the current user write access to the node_modules directory can resolve the problem.

```sh
sudo chown -R $(whoami) /usr/local/lib/node_modules
npm install -g @offckb/cli
```

## Contributing

check [development doc](/docs/develop.md)
