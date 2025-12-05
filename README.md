## OffCKB

[![npm](https://img.shields.io/npm/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![CI](https://github.com/retricsu/offckb/actions/workflows/node.js.yml/badge.svg)](https://github.com/retricsu/offckb/actions/workflows/node.js.yml)
[![npm](https://img.shields.io/npm/dt/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)
[![npm](https://img.shields.io/npm/l/@offckb/cli.svg?maxAge=1000)](https://github.com/jeffijoe/@offckb/cli/blob/master/LICENSE.md)
[![node](https://img.shields.io/node/v/@offckb/cli.svg?maxAge=1000)](https://www.npmjs.com/package/@offckb/cli)

CKB local development network for your first try.

- One-line command to start a devnet, no docker required
- Pre-funded test accounts
- Built-in scripts like [CKB-JS-VM](https://github.com/nervosnetwork/ckb-js-vm) and [Spore-contract](https://github.com/sporeprotocol/spore-contract)
- Create boilerplate to build CKB Smart Contract in Typescript
- Proxy RPC that automatically dumps failed transactions for easier debugging

**Migrate from v0.3.x to v0.4.x:**

There are BREAKING CHANGES between v0.3.x and v0.4.x, make sure to read the [migration guide](/docs/migration.md) before upgrading.

----

- [OffCKB](#offckb)
- [Install](#install)
- [Usage](#usage)
- [Get started](#get-started)
  - [1. Run a Local CKB Devnet {#running-ckb}](#1-run-a-local-ckb-devnet-running-ckb)
  - [2. Create a New Contract Project {#create-project}](#2-create-a-new-contract-project-create-project)
  - [3. Deploy Your Contract {#deploy-contract}](#3-deploy-your-contract-deploy-contract)
  - [4. Debug Your Contract {#debug-contract}](#4-debug-your-contract-debug-contract)
  - [5. Explore Built-in Scripts {#explore-scripts}](#5-explore-built-in-scripts-explore-scripts)
  - [6. Tweak Devnet Config {#tweak-devnet-config}](#6-tweak-devnet-config-tweak-devnet-config)
- [Config Setting](#config-setting)
  - [List All Settings](#list-all-settings)
  - [Set CKB version](#set-ckb-version)
  - [Set Network Proxy](#set-network-proxy)
- [Log-Level](#log-level)
- [Built-in scripts](#built-in-scripts)
- [Accounts](#accounts)
- [About CCC](#about-ccc)
- [FAQ](#faq)
- [Contributing](#contributing)

## Install

```sh
npm install -g @offckb/cli
```

or use `pnpm` to install:

```sh
pnpm install -g @offckb/cli
```

_Require Node version `>= v20.0.0`. We recommend using latest [LTS](https://nodejs.org/en/download/package-manager) version of Node to run `offckb`_

## Usage

```sh
Usage: offckb [options] [command]

ckb development network for your first try

Options:
  -V, --version                                 output the version number
  -h, --help                                    display help for command

Commands:
  node [CKB-Version]                            Use the CKB to start devnet
  create [options] [project-name]               Create a new CKB Smart Contract project in JavaScript.
  deploy [options]                              Deploy contracts to different networks, only supports devnet and testnet
  debug [options]                               Quickly debug transaction with tx-hash
  system-scripts [options]                      Print/Output system scripts of the CKB blockchain
  clean                                         Clean the devnet data, need to stop running the chain first
  accounts                                      Print account list info
  deposit [options] [toAddress] [amountInCKB]   Deposit CKB tokens to address, only devnet and testnet
  transfer [options] [toAddress] [amountInCKB]  Transfer CKB tokens to address, only devnet and testnet
  transfer-all [options] [toAddress]            Transfer All CKB tokens to address, only devnet and testnet
  balance [options] [toAddress]                 Check account balance, only devnet and testnet
  debugger                                      Port of the raw CKB Standalone Debugger
  status [options]                              Show ckb-tui status interface
  config <action> [item] [value]                do a configuration action
  help [command]                                display help for command
```

_Use `offckb [command] -h` to learn more about a specific command._

## Get started

### 1. Run a Local CKB Devnet {#running-ckb}
    
Start a local blockchain with one command:

```sh
offckb node
```

Specify a CKB version:

```sh
offckb node 0.201.0
```

Or set a default version globally:

```sh
offckb config set ckb-version 0.201.0
offckb node
```

Or specify the path to your locally compiled CKB binary:

```sh
offckb node --binary-path /path/to/your/ckb/binary
```

When using `--binary-path`, it will ignore the specified version and network, and only work for devnet.

**RPC & Proxy RPC**

When the Devnet starts:

- The RPC server runs at [http://127.0.0.1:8114](http://127.0.0.1:8114/)
- The proxy RPC server runs at [http://127.0.0.1:28114](http://127.0.0.1:28114/)

The proxy RPC server forwards all requests to the RPC server and record every requests while automatically dumping failed transactions for easier debugging.

You can also start a proxy RPC server for public networks: 

```sh
offckb node --network <testnet or mainnet>
```

Using a proxy RPC server for Testnet/Mainnet is especially helpful for debugging transactions, since failed transactions are dumped automatically.

**Watch Network With TUI**

Once you start the CKB Node, you can use `offckb status --network devnet/testnet/mainnet` to start a CKB-TUI interface to monitor the CKB network from your node.

### 2. Create a New Contract Project {#create-project}
    
Generate a ready-to-use smart-contract project in JS/TS using templates:
```sh
offckb create <your-project-name> -c <your-contract-name>
```
- The `-c` option is optional, if not provided, the contract name defaults to `hello-world`.

### 3. Deploy Your Contract {#deploy-contract}
    
```sh
offckb deploy --network <devnet/testnet> --target <path-to-your-contract-binary-file-or-folder> --output <output-folder-path>
```
- Deployment info is written to the `output-folder-path` you specify.

**Upgradable Scripts with `--type-id`**
Pass the `--type-id` option if you want your Scripts to be upgradable:

```sh
offckb deploy --type-id --network <devnet/testnet>
```

- **Important**: Upgrades are keyed by the contract‘s artifact name.
    - If you plan to upgrade with `--type-id`, do not rename your contract artifact (e.g. keep `hello-world.bc`).
    - Renaming it makes the offckb unable to find the previous Type ID info from the `output-folder-path` and will create a new Type ID.

### 4. Debug Your Contract {#debug-contract}
    
When you interact with the CKB Devnet through the Proxy RPC server (localhost:28114), any failed transactions are automatically dumped and recorded for debugging. 
    
**Debug a Transaction:** 

```sh
offckb debug --tx-hash <transaction-hash> --network <devnet/testnet>
```

output example:

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

Debug a Single Cell Script:

```sh
offckb debug <transaction-hash> --single-script <single-cell-script-option>
```

The `single-cell-script-option` format is `<cell-type>[<cell-index>].<script-type>`

- `cell-type` → `input` or `output`
- `cell-index` → index of the Cell in the transaction
- `script-type` → `lock` or `type`

Example:

```sh
offckb debug --tx-hash <tx-hash> --single-script input[0].lock
```

All debug utilities are powered by [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger/tree/develop/ckb-debugger).
    
### 5. Explore Built-in Scripts {#explore-scripts}
    
Print all the predefined Scripts for the local blockchain:

```sh
offckb system-scripts --list
```

Export options:

- Lumos format

```sh
offckb system-scripts --export-style lumos
```

- CCC format:

```sh
offckb system-scripts --export-style ccc
```

- Save to a JSON file:

```sh
offckb system-scripts --output <output-file-path>
```
    
### 6. Tweak Devnet Config {#tweak-devnet-config}
    
By default, OffCKB use a fixed Devnet config. You can customize it, for example by modifying the default log level (`warn,ckb-script=debug`).

1. Locate your Devnet config folder:
    
```sh
offckb config list
```

Example result:

```json
{
  "devnet": {
    "rpcUrl": "http://127.0.0.1:8114",
    "configPath": "~/Library/Application Support/offckb-nodejs/devnet",
    "dataPath": "~/Library/Application Support/offckb-nodejs/devnet/data"
  }
}
```
Pay attention to the `devnet.configPath` and `devnet.dataPath`.
    
2. `cd` into the `devnet.configPath` . Modify the config files as needed. See [Custom Devnet Setup](https://docs.nervos.org/docs/node/run-devnet-node#custom-devnet-setup) and [Configure CKB](https://github.com/nervosnetwork/ckb/blob/develop/docs/configure.md) for details.
3. After modifications, remove everything in the `devnet.dataPath` folder to reset chain data.
4. Restart local blockchain by running `offckb node`


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

## Log-Level

You can tweak env `LOG_LEVEL` to control the `offckb` log level.

For example, set `LOG_LEVEL=debug` gives you more outputs of offckb proxy RPC.

```sh
LOG_LEVEL=debug offckb node
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
- [x] CKB-JS-VM https://github.com/nervosnetwork/ckb-js-vm
  - version: 1.0.0
- [x] Nostr-Lock https://github.com/cryptape/nostr-binding/tree/main/contracts/nostr-lock
  - version: 25dd59d
- [x] Type ID built-in

## Accounts

OffCKB comes with 20 pre-funded accounts, each initialized with `42_000_000_00000000` capacity in the genesis block.

- All private keys are stored in the `account/keys` file.
- Detailed information for each account is recorded in `account/account.json`.
- When deploying contracts, the deployment cost are automatically deducted from these pre-funded accounts. This allows you to test deployments without faucets or manual funding.

:warning: **DO NOT SEND REAL ASSETS TO THESE ACCOUNTS. THE KEYS ARE PUBLIC, AND YOU MAY LOSE YOUR MONEY** :warning:

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

