# Migration from v0.3.x to v0.4.x

## BREAKING CHANGES

1. The default log level in CKB devnet Node is changed to `warn,ckb-script=debug` from `info` to display the script debug output
2. The devnet RPC proxy sever is now default running, and proxy port is changed to `28114` from `9000`
3. The `create` command is now focusing on creating a CKB Smart Contract project in JavaScript, instead of a full dApp project.
4. `offckb.config.ts` file is removed, and the `deploy` command now requires `--target` and `--output` options to specify the contract binary file or folder path and the output folder path.
5. More built-in scripts added, including `ckb-js-vm`, `nostr-lock` and `type_id` script.
6. `system-scripts` command has a new option called `-o, --output` to specify the output json file path for the system scripts.
7. The CLI build system is changed from `npm-shrinkwrap.json` to `ncc` toolchain.
8. the CLI now requires no `ckb-debugger` installed to run `offckb debug` command, it will use the WASM debugger built in.

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
