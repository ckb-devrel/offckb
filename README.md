## OffCKB

[![npm](https://img.shields.io/npm/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![CI](https://github.com/retricsu/offckb/actions/workflows/node.js.yml/badge.svg)](https://github.com/retricsu/offckb/actions/workflows/node.js.yml)
[![npm](https://img.shields.io/npm/dt/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![npm](https://img.shields.io/npm/l/@offckb/cli.svg?maxAge=1000)](https://github.com/jeffijoe/@offckb/cli/blob/master/LICENSE.md)
[![node](https://img.shields.io/node/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)

**CKB local development network for your first try.**

- One-line command to start a devnet
- No docker required
- Pre-funded test accounts
- Built-in scripts like [Omnilock](https://github.com/cryptape/omnilock) and [Spore-contract](https://github.com/sporeprotocol/spore-contract)
- Multiple minimal dApp templates to learn and get your hands dirty

Start building on CKB blockchain, right now, right away!

## Table of Contents

- [OffCKB](#offckb)
- [Table of Contents](#table-of-contents)
- [Install](#install)
- [Usage](#usage)
- [Get started](#get-started)
  - [Running CKB](#running-ckb)
  - [List scripts info](#list-scripts-info)
  - [Create a full-stack Project](#create-a-full-stack-project)
  - [Create a script-only Project](#create-a-script-only-project)
  - [Build and Deploy a script](#build-and-deploy-a-script)
  - [Start the frontend project](#start-the-frontend-project)
  - [Debug a transaction](#debug-a-transaction)
  - [Generate Moleculec bindings](#generate-moleculec-bindings)
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

*We recommand using [LTS](https://nodejs.org/en/download/package-manager) version of Node to run `offckb`*

## Usage

```sh
Usage: offckb [options] [command]

ckb development network for your first try

Options:
  -V, --version                                     output the version number
  -h, --help                                        display help for command

Commands:
  create [options] [your-project-name]              Create a new dApp from bare templates
  node [options] [CKB-Version]                      Use the CKB to start devnet
  proxy-rpc [options]                               Start the rpc proxy server
  clean                                             Clean the devnet data, need to stop running the chain first
  accounts                                          Print account list info
  list-hashes [CKB-Version]                         Use the CKB to list blockchain scripts hashes
  inject-config                                     Add offckb.config.ts to your workspace
  sync-config                                       Sync offckb.config.ts in your workspace
  deposit [options] [toAddress] [amountInShannon]   Deposit CKB tokens to address, only devnet and testnet
  transfer [options] [toAddress] [amountInShannon]  Transfer CKB tokens to address, only devnet and testnet
  balance [options] [toAddress]                     Check account balance, only devnet and testnet
  deploy [options]                                  Deploy contracts to different networks, only supports devnet and testnet
  my-scripts [options]                              Show deployed contracts info on different networks, only supports devnet and testnet
  config <action> [item] [value]                    do a configuration action
  debug [options]                                   CKB Debugger for development
  system-scripts [options]                          Output system scripts of the local devnet
  mol [options]                                     Generate CKB Moleculec binding code for development
  help [command]                                    display help for command
```

*Use `offckb [command] -h` to learn more about a specific command.*

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

List all the predefined scripts for the blockchain:

```sh
offckb system-scripts --network devnet
```

Or export the scripts info to a lumos JSON file:

```sh
offckb system-scripts --network devnet --export-style lumos
```

Or print the scripts info in a CCC style:

```sh
offckb system-scripts --network devnet --export-style ccc
```

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

Note: you need to have rust/cargo/cargo-generate/clang 16+ installed in your environment to use this command. offckb doesn't do anything really, it just call [ckb-script-template](https://github.com/cryptape/ckb-script-tempaltes) to do all the magic.

### Build and Deploy a script

The fullstack boilerplate project is a monorepo, which contains a script project and a frontend project.

To build the script, in the root of the project, run: 

```sh
make build
```

To deploy the script, cd into the frontend folder and run:

```sh
offckb deploy --network <devnet/testnet>
```

Once the deployment is done, you can use the following command to check the deployed scripts:

```sh
offckb my-scripts --network <devnet/testnet>
```

Your deployed scripts will be also be listed in the `offckb/my-scripts` folder in your frontend project.

### Start the frontend project

To start the frontend project, cd into the frontend folder and run:

```sh
npm run dev
```

### Debug a transaction

If you are using the proxy RPC server, all the failed transactions will be dumped and recorded so you can debug them later.

Everytime you run a transaction, you can debug it with the transaction hash:

```sh
offckb debug <transaction-hash>
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

All the debug utils are borrowed from [ckb-debugger](https://github.com/nervosnetwork/ckb-debugger).

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

`offckb` uses [CCC](https://github.com/ckb-ecofund/ccc) as the development framework to build the CKB dApp template projects.

## FAQ

Sometimes you might encounter sudo permission problems. Granting the current user write access to the node_modules directory can resolve the problem.

```sh
sudo chown -R $(whoami) /usr/local/lib/node_modules
npm install -g @offckb/cli
```

## Contributing

check [development doc](/docs/develop.md)
