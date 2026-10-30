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
  fiber init [FNN-Version]                      Prepare Fiber configs and keys without starting FNN (optional)
  fiber start [FNN-Version]                     Start Fiber (FNN) nodes on the running devnet CKB
  fiber stop                                    Stop the daemon-managed fiber nodes
  fiber status                                  Show the status of the local CKB and all fiber nodes
  fiber logs --node <id>                        Show the log of a fiber node
  fiber clean                                   Clean the fiber environment
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
  install <tool>                                Install a tool binary used by offckb (e.g. the native ckb-debugger)
  debugger                                      Port of the raw CKB Standalone Debugger
  status [options]                              Show ckb-tui status interface
  logs [options] [target]                       Show devnet logs: node (default), contract script debug output, miner, or RPC proxy events
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

If a fiber environment is running in a foreground terminal, `node stop` refuses rather than orphaning its FNNs on a stopped chain — stop them there first, or pass `offckb node stop --force` to stop CKB anyway (the FNNs keep running).

**View Logs**

A foreground `offckb node` stays quiet by default: it prints lifecycle events, contract script debug output (`debug!` in your scripts), submitted transaction hashes, and RPC errors. The node, miner, and RPC proxy always write full logs to files under the devnet data folder, and `offckb logs` reads them in any run mode (foreground, daemon, or while `offckb status` is attached):

```sh
offckb logs                # node log (default)
offckb logs script         # contract script debug output only
offckb logs miner          # miner log
offckb logs rpc            # RPC requests, transaction hashes, RPC errors
offckb logs -f             # stream new lines, tail -f style
offckb logs --tail 200 --grep ERROR
```

Use `offckb node --verbose` to restore the old behavior of printing the full raw node/miner output to the terminal.

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

The TUI's system-metric panels are powered by CKB's `Terminal` RPC module, which requires CKB >= 0.205.0. If you run the devnet with an older CKB (e.g. `offckb node 0.120.0` or `--binary-path` pointing at an old build), offckb starts the node without that module and those panels will be unavailable; upgrade CKB to get them.

### 2. Create a New Contract Project {#create-project}

Generate a ready-to-use smart-contract project in JS/TS using templates:

```sh
offckb create <your-project-name> -c <your-contract-name>
```

- The `-c` option is optional, if not provided, the contract name defaults to `hello-world`.

**Note for Windows Users:**

The generated project uses `ckb-testtool` with the WASM debugger by default, which works on all platforms. To run mock tests with the _native_ debugger instead (for example, while debugging upstream WASM issues), install `ckb-debugger` once with offckb:

```sh
offckb install ckb-debugger
```

This downloads the prebuilt `ckb-debugger` binary for your platform from the official [ckb-standalone-debugger releases](https://github.com/nervosnetwork/ckb-standalone-debugger/releases) and puts a `ckb-debugger` shim next to the offckb binary so it is available on PATH.

Then disable the WASM debugger in your mock test file:

1. Open the mock test file (e.g., `<your-contract-name>.mock.test.ts`)
2. Comment out or delete the `verifier.setWasmDebuggerEnabled(true)` line:
   ```typescript
   // When using native ckb-debugger, comment out or delete the following line:
   // verifier.setWasmDebuggerEnabled(true);
   ```

After completing these steps, `npm run test` should pass without mock test failures.

`offckb create` installs `ckb-debugger` for you automatically when it is missing.

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

All debug utilities are powered by [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger/tree/develop/ckb-debugger).

**Install the Native ckb-debugger**

`offckb debug` requires the native `ckb-debugger` binary. Install it once with:

```sh
offckb install ckb-debugger
```

This downloads the prebuilt binary for your platform from the official [ckb-standalone-debugger releases](https://github.com/nervosnetwork/ckb-standalone-debugger/releases) (no Rust toolchain or compilation needed), verifies its checksum, and exposes it on PATH.

To uninstall, remove the binary under the offckb data directory (see `offckb config list`) and the `ckb-debugger` shim next to the offckb binary.

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

By default, OffCKB use a fixed Devnet config. You can customize it, for example by modifying the default log level (`info,ckb-script=debug`).

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

1. Save changes and restart devnet. Stop a foreground node with Ctrl+C, or stop a daemon with:

```sh
offckb node stop
offckb node # reuse the original options, e.g. --fiber --daemon
```

Restart with the same options used originally, including `--fiber` when applicable, so Fiber starts with CKB again. If Fiber was started separately with `fiber start`, stop it before CKB and restart it separately afterward.

Ordinary runtime config changes do not require deleting data. Changes to the genesis/spec may require an explicit reset with `offckb clean -d`: this deletes chain history and Fiber channel/payment stores, while preserving configs and keys. If system-cell hashes changed, update the retained Fiber contract references before starting Fiber; see [recovery after genesis or contract changes](docs/fiber-devnet.md#修改创世或系统合约后的恢复). `offckb clean` removes the environment under the devnet directory, including Fiber keys; externally referenced files remain.

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
2. Stop and restart the local blockchain with `offckb node` and the original options (including `--fiber` if used) to apply runtime changes.
3. Only when rebuilding the genesis/spec, explicitly reset with `offckb clean -d`; it deletes chain history and Fiber channel/payment stores while keeping the updated configs and keys.

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

### 8. Run a Fiber Devnet {#fiber-devnet}

OffCKB can start and manage a local [Fiber](https://github.com/nervosnetwork/fiber) development environment on top of the devnet: the Fiber contracts (`auth`, `funding_lock`, `commitment_lock`) live in the local chain's genesis block, and each FNN node gets its own CKB account, network identity, ports, data and log file.

```sh
# Start CKB, miner, RPC proxy and 2 FNN nodes in one command
offckb node --fiber

# Or start only the FNN nodes on an already-running devnet (auto-initializes on first use)
offckb node
offckb fiber start

# Background mode
offckb node --fiber --daemon      # one manager for CKB + FNNs, stopped by `offckb node stop`
offckb fiber start --daemon       # separate fiber manager, stopped by `offckb fiber stop`

# Inspect
offckb fiber status [--json]
offckb fiber logs --node 1 [-f]

# Clean up
offckb fiber clean --data         # delete only the FNN stores (channels/payments)
offckb fiber clean                # delete the whole fiber environment
```

- Only the plain local devnet is supported: no mainnet/testnet, and no forked devnet (a `fork.json` present in the devnet directory rejects Fiber startup).
- OffCKB manages FNN processes, configuration, accounts and management RPC. It does not depend on LSP or `lsp-cli`; extension features are optional and must be supported by the selected FNN executable.
- A devnet created by an offckb version without Fiber support does not have the Fiber contracts in its genesis. `fiber start` / `node --fiber` on such a devnet refuse with migration guidance: rebuild with `offckb clean` (which deletes the local chain data) and start again; a plain `offckb node` keeps working on the old devnet unchanged.
- New node `N` defaults to built-in CKB account `N+2`, RPC port `21713+N` and P2P port `8343+N`. The account binding is saved, not recalculated on restart. Up to 16 nodes: first start with `offckb fiber start --nodes 4`, or prepare them without starting with `offckb fiber init --nodes 4`. Append a node with `offckb fiber init --add`; optionally choose `--account-index 12` or `--random-account` (unfunded).
- First initialization downloads a tested FNN release (currently `0.9.0`), unless a version or `--binary-path <fnn>` is supplied (`--fnn-binary-path` with `node --fiber`). Downloads are verified against pinned SHA-256 digests. The absolute program and template paths are saved in `fiber/nodes.yml`; subsequent starts reuse that program without downloading or upgrading. Startup selection flags must agree with an existing environment. Use `fiber init --add` or `fiber init --nodes N` to prepare additional nodes.
- Every FNN writes stdout/stderr to `devnet/fiber/nodes/<id>/fnn.log`. Each node has a persistent full `config.yml`, generated once by initialization and never overwritten by startup. `nodes.yml` records its `config_file`, funding `account`, and `rpc_token_file`; relative paths resolve from `nodes.yml`. Keep the local chain/scripts, fixed ports, node store location and required `fiber`/`rpc`/`ckb` services and `info`/`peer` RPC modules. Other services and modules may be added. The old `nodes[].config` format is unsupported; there is no legacy environment migration.
- Startup checks every registered config and key before creating FNN processes, then verifies chain, network identity and funding lock. Zero-balance accounts can start and wait for external funding; initialization does not pre-fund random accounts. Shared funding locks are permitted with a warning about Cell contention. Missing files or changed account bindings fail explicitly instead of generating replacement keys.
- One fiber environment per machine: the RPC/P2P ports are fixed per node id, so a second concurrent fiber environment fails its port check. Note the CKB side of the check is the chain's genesis hash, and every plain offckb devnet shares the same genesis — if you run several offckb environments on one machine (e.g. separate `XDG_DATA_HOME`), make sure `fiber start` attaches to the CKB you actually started for it; when in doubt, check `offckb fiber status` against the environment you mean to use.
- Initialization also prepares independent Biscuit keys (`nodes/<id>/biscuit/private.key`, `public.key`) and a management `rpc-token` for each node. Authentication is off by default; to enable it, put the generated public key in `rpc.biscuit_public_key`. OffCKB automatically sends the node's token on internal RPC calls and reports authentication errors separately from stopped nodes. If you or an external tool replace the RPC public key, also supply a matching management token with node/peer permissions. These credentials do not grant channel/payment access.
- `fiber status` includes `CUSTOM_CONFIG` (`yes`, `no`, `unknown`) compared with the node's initialization baseline `config.default.yml`. Running nodes use their startup snapshot until restarted; stopped/new nodes report pending config. Missing baselines do not overwrite user files. Runtime records contain public account information and credential paths, never private keys or token contents.
- Stop/restart preserves chain and Fiber data. `fiber clean --data` resets only FNN stores and keeps configs, accounts, passwords, Biscuit keys and tokens. Both data-only clean commands refuse before deleting anything if a registered config/token file is inside a deletion target; relocate the file and update `nodes.yml` first. `fiber clean` deletes the Fiber directory; `clean --data` resets the chain and dependent FNN stores; `clean` deletes the devnet directory. Referenced files outside the directory being removed remain. None of the clean commands is a normal restart.

To customize a node before its first launch, after CKB is running:

```sh
offckb fiber init --nodes 3 --binary-path /absolute/path/to/fnn
# Edit the printed node config for features supported by your FNN executable.
offckb fiber start --daemon
# After editing config: stop and start Fiber to apply changes.
offckb fiber stop
offckb fiber start --daemon
```

The complete lifecycle and configuration contract is in [Fiber devnet design](docs/fiber-devnet.md).

- UDT channels: the FNN config whitelists the devnet sUDT and xUDT issued by built-in account 19, so issue test UDTs from that account (`offckb udt issue ... --privkey-file` with account 19's key) to the node accounts before opening UDT channels. A few things that differ from plain CKB channels:
  - `offckb udt issue <amount>` takes the amount in the token's base unit (no 10^8 conversion): `3000` issues 0.00003 sUDT at 8 decimals, so issue generously before funding a channel.
  - Both sides of a UDT channel must hold the UDT. The accepting node needs its own UDT cells — otherwise `accept_channel` fails with "can not find enough UDT owner cells" — so issue the UDT to both node accounts first.
  - UDT channels are not auto-accepted (CKB channels are). After `open_channel` the peer stays in `NegotiatingFunding` until you call `accept_channel` on the peer node, and its `funding_amount` must be `0x0` — a nonzero amount fails with "invalid funding tx".

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
- [x] Fiber (auth / funding-lock / commitment-lock) https://github.com/nervosnetwork/fiber
  - commit id: e6cb7ac (FNN v0.9.0)
- [x] Type ID built-in

## Accounts

On a pure OffCKB devnet, OffCKB comes with 20 pre-funded accounts, each initialized with `42_000_000_00000000` capacity in the genesis block. A fork keeps the source chain genesis and therefore has no OffCKB genesis allocation; built-in dev accounts are funded by locally mined cellbase cells instead.

```sh
offckb accounts                      # prints address, private key, pubkey and lock script
offckb accounts --hide-private-keys  # omit private keys, e.g. when output goes to logs
```

The built-in accounts are public test keys, so `accounts` prints their private keys by default (also in `--json` output).

On a Mainnet fork, `accounts` re-encodes the same dev lock scripts with the `ckb` address prefix, so private keys are hidden by default there; pass `--show-private-keys` (trusted local terminals only) to print them. Once the Indexer is caught up it also reports each account's spendable pure-CKB balance; until then the field is omitted with a warning.

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

## Experimental local plugins

Local tool packages can be explicitly linked with `offckb plugin link <directory>`, inspected with `offckb plugin list`, and run as `offckb <plugin-command>`. The host enforces an OS sandbox with explicit capability grants, supplies restricted devnet context and owns foreground cleanup. Plugins currently require macOS/Linux and Node 22.21+ (22.x) or 24.5+; unsupported environments fail closed. See the [plugin guide](docs/plugins.md) for the context probe, plugin contract, and security limits. Registry installation and background plugins are not implemented yet.

## Contributing

check [development doc](/docs/develop.md)
