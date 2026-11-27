# Migration from v0.4.x to v0.5.0

This guide compares the latest v0.4 release, v0.4.13, with v0.5.0. If you are upgrading from an earlier v0.4 patch, also check the intervening entries in the [changelog](../CHANGELOG.md). The core CLI still requires Node.js 20 or later.

## Keep your current devnet

Stop the old process (Ctrl+C in the foreground or `offckb node stop` for a daemon), upgrade the CLI with your package manager, and restart with the same CKB version, binary path and other options you used before. A plain `offckb node` reuses your existing chain spec and data. Existing forks can still be started with their original options. Skip `offckb clean` for this upgrade path.

## Rebuild only if you want Fiber on an existing v0.4 devnet

New plain devnets use a genesis that includes `auth`, `funding_lock` and `commitment_lock`. An existing v0.4 devnet keeps its old genesis, so Fiber refuses to start if these contracts are absent. Fiber supports plain local devnets only.

1. Stop CKB and any FNN processes. Back up the devnet config and data directories shown by `offckb config list` if you need the old chain.
2. To replace that devnet, run `offckb clean`. This deletes the devnet directory, including the local chain and its configuration. `offckb clean --data` keeps the old `specs/dev.toml`, so it cannot install the new genesis.
3. Run `offckb node --fiber` (add `--daemon` if desired). The rebuilt chain has a different genesis hash. Redeploy local contracts, refresh any project copies of the deployment records, and rerun `offckb system-scripts -o <path>` for projects using cached system script references.

Fresh v0.5.0 installations can start with `offckb node --fiber` directly. See the [Fiber devnet guide](fiber-devnet.md) for configuration and data lifecycle.

## Update scripts that call OffCKB

| If you use | Change for v0.5.0 |
| --- | --- |
| `offckb accounts` in scripts, logs or JSON consumers | Add `--hide-private-keys` to preserve the v0.4 default. Both output formats now include `privkey` for built-in test accounts by default. Mainnet forks still hide it unless you pass `--show-private-keys`. |
| A hard-coded path to the OffCKB-managed `ckb-debugger` | Run `offckb install ckb-debugger` and discover the registered binary via `offckb plugin which ckb-debugger` (add `--json` for structured output). A qualifying legacy binary can be adopted offline and its old directory removed after registration. |
| `offckb install ckb-debugger` to fetch the newest upstream release | The command is now an alias of `offckb plugin install ckb-debugger`. The v0.5.0 catalog pins `1.1.2`. On first registration, the bare name, `@latest` and `@1.1.2` can all adopt a qualifying legacy binary. If adoption keeps a different version, rerun the install to get the pin on platforms with a catalog asset. On Intel macOS, keep the adopted version or use a compatible local build. |
| `offckb config set` or `offckb config rm proxy` | Handle a nonzero exit when `settings.json` is unreadable, malformed, or cannot be saved. Repair the file or its permissions using the path in the error, then retry. |
| `offckb clean --data` for a chain reset | With Fiber configured, this also deletes the OffCKB-managed Fiber stores, including channels and payments. Configs, accounts and keys are preserved. Stop CKB and Fiber first. For an ordinary runtime config change, stop and restart with the original options. |
| `offckb node stop` with Fiber running | When Fiber has a separate manager, stop it first (`offckb fiber stop` for a daemon or Ctrl+C in the foreground). If you started CKB and Fiber together with `offckb node --fiber --daemon`, `offckb node stop` stops both. |

`offckb debug` and `offckb debugger` still support an existing native debugger on PATH or in the legacy install directory. If a generated project calls the bare `ckb-debugger` executable, check PATH after installing or adopting it. See [debugger migration and shim behavior](binary-tools.md#upgrading-ckb-debugger).

## If you used a v0.5 canary

- FNN v0.9.0 replaces the release candidate as the only version OffCKB downloads. For a fresh environment, remove any saved RC version override from the startup command and set `offckb config set fnn-version 0.9.0` if you previously changed the default. Existing environments in the current format reuse their saved FNN path.
- Early Fiber canaries used `nodes[].config`. Stop all FNN processes, then move the entire `fiber` directory under `devnet.configPath` to a backup location outside that path. Find `devnet.configPath` with `offckb config list`. With a compatible plain devnet running, run `offckb fiber init` to prepare the new environment. Reapply supported settings in the per-node configs referenced by `config_file`, then run `offckb fiber start` (add `--daemon` if desired). On first startup, FNN generates new network identities and opens empty stores. The old identities and stores remain in the backup. See the [Fiber guide](fiber-devnet.md).
- For binary tools, use `offckb plugin install <catalog-name>` or `offckb plugin install ./dir` with an `offckb-tool.json` and its executable. Use these install forms in place of early canary `tool:` sources, descriptor-file installs, or binary links. For a tool previously registered with `plugin link`, run `offckb plugin unlink <command>` before installing the same command. Unlinking removes the registration and leaves the source files in place. See the [current source matrix](plugins.md#what-to-type-in-one-table).
- If automation parsed the human-readable `offckb plugin list` output, switch to `offckb --json plugin list`. The text output now groups JavaScript plugins and binary tools, while JSON retains the structured plugin and catalog records.

# Migration from v0.3.x to v0.4.x

> **Important for the v0.3.x to v0.4.x upgrade:** Back up the local devnet if needed, then run `offckb clean` before upgrading across this version boundary.

## BREAKING CHANGES

1. The Node engine is required at least `v20.0.0`, Node version below `v20` is not expected to work.
2. More built-in scripts added, including `ckb-js-vm`, `nostr-lock`,  `pw-lock`, `multisig-v2` and `type_id` script.
3. The chain information of the devnet has changed due to the No.1 changes, meaning you need to re-generate the `system-scripts.json` file in your project if you're upgrading from v0.3.x to v0.4.x.
4. The default log level in CKB devnet Node is changed to `warn,ckb-script=debug` from `info` to display the script debug output
5. The devnet RPC proxy sever is now default running, and proxy port is changed to `28114` from `9000`. You need to update the devnet proxy port in your local config file if you have used v3 offckb before.
6. The `offckb node` command now accepts a `network` option, when passing `--network testnet` or `--network mainnet`, it will start a proxy RPC for the public network instead of starting a local devnet.
7. The `create` command is now focusing on creating a CKB Smart Contract project in JavaScript, instead of a full dApp project.
8. `offckb.config.ts` file is removed, and the `deploy` command now requires `--target` and `--output` options to specify the contract binary file or folder path and the output folder path.
9. `system-scripts` command has a new option called `-o, --output` to specify the output json file path for the system scripts.
10. The CLI build system is changed from `npm-shrinkwrap.json` to `ncc` toolchain.
11. The CLI now requires no `ckb-debugger` installed to run `offckb debug` command, it will use the WASM debugger built-in.

## Removed commands

- `proxy-rpc`
- `mol`
- `repl`
- `list-hashes`
- `my-scripts`
- `sync-scripts`
- `inject-config`

## Add new commands

- `debugger`: a port of the rust CKB Standalone Debugger, you can use `offckb debugger <...params>` just like using `ckb-debugger <...params>` with no installation required.

# Migration from v0.2.x to v0.3.x

## BREAKING CHANGES

1. Rename Devnet chain name in `dev.toml` config from `offckb` to standard `ckb_dev`
2. Rename `sync-config` to `sync-scripts`
3. Rename `deployed-scripts` to `my-scripts`
4. Templates `offckb.config.ts` file are refactored with NEW structure

## Add new commands

1. `proxy-rpc`
2. `system-scripts`
3. `debug`
4. `mol`
5. `transfer-all`
6. `repl`
