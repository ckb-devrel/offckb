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

---

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
  - [7. Fork Mainnet/Testnet Into Your Devnet {#fork-devnet}](#7-fork-mainnettestnet-into-your-devnet-fork-devnet)
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

**Note for Windows users:** If installation fails due to native module compilation issues, the CLI will still work but may use portable binaries instead of optimized ones. For better performance, consider installing Visual Studio Build Tools.

## Usage

```sh
Usage: offckb [options] [command]

ckb development network for your first try

Options:
  -V, --version                                 output the version number
  --json                                        Output one command result as JSON on stdout and logs as NDJSON on stderr
  -h, --help                                    display help for command

Commands:
  node [CKB-Version]                            Use the CKB to start devnet
  node stop                                     Stop the running CKB devnet daemon
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
  devnet config                                 Edit devnet configuration
  devnet info                                   Show fork metadata and node/indexer readiness
  devnet fork [options]                         Fork Mainnet/Testnet state into the local devnet
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

**Run in Daemon Mode**

Start the devnet in the background so your terminal stays free:

```sh
offckb node --daemon
```

The daemon writes its logs and PID to the devnet data folder, for example:

- Logs: `~/Library/Application Support/offckb-nodejs/devnet/data/logs/daemon.log`
- PID file: `~/Library/Application Support/offckb-nodejs/devnet/data/logs/daemon.pid`

Stop the daemon later with:

```sh
offckb node stop
```

**Agent-Friendly JSON Output**

For programmatic consumption or agent integration, add `--json` before or after the command:

```sh
offckb --json balance ckt1...
offckb devnet info --json
```

In JSON mode, stdout is reserved for one stable command result. Progress logs are newline-delimited JSON on stderr, and failures use `{ "ok": false, "code", "message" }` with a non-zero exit code. This lets scripts parse stdout without scraping log messages or stack traces:

```json
{ "ok": true, "command": "balance", "network": "devnet", "address": "ckt1...", "ckb": "4200", "udt": [] }
```

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

**Watch Network with TUI**

Once you start the CKB Node, launch the interactive CKB-TUI for one network:

```sh
offckb status --network devnet
offckb status --network testnet
offckb status --network mainnet
```

`status` performs a JSON-RPC health check through the proxy before opening the TUI and requires an interactive terminal.

### 2. Create a New Contract Project {#create-project}

Generate a ready-to-use smart-contract project in JS/TS using templates:

```sh
offckb create <your-project-name> -c <your-contract-name>
```

- The `-c` option is optional, if not provided, the contract name defaults to `hello-world`.

**Note for Windows Users:**

To run mock tests in the generated project, you need to manually install `ckb-debugger` until [this upstream fix about ckb-testtool wasm](https://github.com/nervosnetwork/ckb-js-vm/pull/98) is applied.

**Installation Steps:**

1. Download the latest `ckb-debugger` release for Windows from the [releases page](https://github.com/nervosnetwork/ckb-standalone-debugger/releases)
2. Extract the downloaded archive (e.g., `ckb-debugger-win64.zip`)
3. Add the extracted binary to your system PATH:
   - Open "System Properties" → "Environment Variables"
   - Under "System variables" or "User variables", find and edit the `Path` variable
   - Click "New" and add the full path to the folder containing `ckb-debugger.exe`
   - Click "OK" to save
4. Verify installation by opening a new terminal and running:
   ```sh
   ckb-debugger --version
   ```
5. Disable WASM debugger in your mock test file:
   - Open the mock test file (e.g., `<your-contract-name>.mock.test.ts`)
   - Comment out or delete the `verifier.setWasmDebuggerEnabled(true)` line:
   ```typescript
   // When using native ckb-debugger, comment out or delete the following line:
   // verifier.setWasmDebuggerEnabled(true);
   ```

After completing these steps, `npm run test` should pass without mock test failures.

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

1. Open the interactive Devnet config editor:

```sh
offckb devnet config
```

The editor uses a three-column layout: first-column file switcher (`ckb.toml` / `ckb-miner.toml`), a middle primary editing pane, and a smaller right read-only reference pane that shows the full built-in template for the currently selected file.

The left editing pane supports full key browsing/editing, including primitive value edits, object key add, array append/insert/move, search filter, and path delete.

Common shortcuts: `Enter` edit primitive, `a` add key/item, `i` insert array item, `m` move array item, `d` delete path, `/` search filter, `n`/`N` next/previous search match, `c` add custom value in fixed-array dialog (when allowed), `s` save, `q` quit.

Note: saving rewrites `ckb.toml` / `ckb-miner.toml` into canonical TOML format; upstream comments and original formatting are not preserved after save.

You can also update the same fields non-interactively (useful for scripts/CI):

```sh
offckb devnet config --set ckb.logger.filter=info
offckb devnet config --set ckb.rpc.enable_deprecated_rpc=true --set miner.client.poll_interval=1500
```

If your terminal is non-interactive (no TTY, e.g. CI/remote pipeline), use `--set` mode directly instead of the full-screen editor.

1. Save changes and restart devnet:

```sh
offckb clean -d
offckb node
```

1. (Advanced) Locate your Devnet config folder for manual edits:

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

1. `cd` into the `devnet.configPath` . Modify the config files as needed. See [Custom Devnet Setup](https://docs.nervos.org/docs/node/run-devnet-node#custom-devnet-setup) and [Configure CKB](https://github.com/nervosnetwork/ckb/blob/develop/docs/configure.md) for details.
2. After modifications, run `offckb clean -d` to remove the chain data if needed while keeping the updated config files.
3. Restart local blockchain by running `offckb node`

### 7. Fork Mainnet/Testnet Into Your Devnet {#fork-devnet}

You can fork an existing Mainnet/Testnet data directory into your local devnet, so it keeps the real on-chain state (deployed contracts, cells) while mining locally with Dummy PoW. This implements the same flow as [Devnet From Existing Data](https://docs.nervos.org/docs/node/devnet-from-existing-data).

```sh
# Point at the directory used by the source node's `ckb -C`:
offckb devnet fork --from /path/to/ckb-data --dry-run
offckb devnet fork --from /path/to/ckb-data
offckb node --daemon
offckb devnet info
```

- Database fork mode requires `--from`; it points at the directory the source node runs with (`ckb -C`), which must contain `data/db`. Keeping the source explicit makes large database copies predictable in local scripts and CI.
- Stop the source node first. Use `--dry-run` to validate the source chain, CKB/DB compatibility, migration requirement, and target without replacing the current devnet.
- The source chain is auto-detected from the source `ckb.toml`; pass `--source mainnet|testnet` when it cannot be detected, and `--spec-file <path>` to use a local chain spec (e.g. offline).
- The command copies the chain state (your original data is never modified), deliberately excludes peer store/log/tmp data, imports the matching chain spec, patches it for local mining, verifies the genesis hash, and writes a fork receipt.
- Fork networking is outbound-isolated: no bootnodes, persisted peers, peer discovery, or outbound peer slots. `offckb devnet info` displays the observed peer count so this property is visible.
- If `ckb migrate --check` says the database is old, the preflight stops before changing the devnet. Re-run with `--migrate`; only the copied database is migrated.
- The first `offckb node` run automatically boots with `--skip-spec-check --overwrite-spec`; later runs are normal. Daemon startup waits for healthy CKB RPC, miner spawn, and proxy health before reporting success.
- Forking replaces the current devnet; use `--force` to replace an existing devnet/fork, or `offckb clean` to reset back to a pure devnet.

`offckb devnet info` reports RPC readiness, node tip, Indexer tip/lag, peer count, network isolation, and fork metadata. Balance and signing commands warn while the Indexer is unavailable or behind instead of silently presenting incomplete state.

On a forked devnet, `offckb system-scripts`, transfers, deploys and `offckb debug --tx-hash <hash>` work against the real source-chain state, e.g. debugging a failed mainnet transaction fully locally.

> [!CAUTION]
> CKB transactions carry no chain id, so a transaction built on a mainnet fork that spends copied mainnet cells is also valid on mainnet (CKB provides no replay protection). offckb's own flows only use dev keys and fork-mined cells, which cannot replay. Never sign transactions with real mainnet keys against a fork unless you intend to broadcast them yourself.

`offckb transfer` fails closed on a Mainnet fork: non-built-in keys require `--allow-external-key-on-mainnet-fork`, and inputs copied from Mainnet are rejected even with that override. (`--allow-mainnet-replay-risk` from 0.4.9 remains as a deprecated alias.)

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

On a pure OffCKB devnet, OffCKB comes with 20 pre-funded accounts, each initialized with `42_000_000_00000000` capacity in the genesis block. A fork keeps the source chain genesis and therefore has no OffCKB genesis allocation; built-in dev accounts are funded by locally mined cellbase cells instead.

```sh
offckb accounts
offckb accounts --show-private-keys  # trusted local terminals only
```

On a Mainnet fork, `accounts` re-encodes the same dev lock scripts with the `ckb` address prefix. Once the Indexer is caught up it also reports each account's spendable pure-CKB balance; until then the field is omitted with a warning. Private keys are hidden by default so JSON and agent logs do not collect them.

- All private keys are stored in the `account/keys` file.
- Detailed information for each account is recorded in `account/account.json`.
- When deploying contracts, the deployment cost are automatically deducted from these pre-funded accounts. This allows you to test deployments without faucets or manual funding.

For commands that accept a private key, prefer `--privkey-file <path>` or `OFFCKB_PRIVATE_KEY` over `--privkey`, which is visible in shell history and process listings.

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
