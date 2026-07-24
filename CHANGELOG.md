# @offckb/cli

## 0.4.10

### Patch Changes

- 699a850: Fix the `status` command showing missing data on devnet: enable the Terminal RPC module and the TCP listen address in the devnet `ckb.toml` template (and the config editor's embedded reference template), and pass the node's TCP listen address to ckb-tui so the system metrics, mempool, and log panels populate correctly. The devnet RPC now binds to `127.0.0.1` instead of `0.0.0.0` so the unauthenticated RPC (including the new host metrics) is no longer reachable from other machines on the network; edit `rpc.listen_address` in the devnet `ckb.toml` if you rely on remote access.
- 45b0e98: Rename `--allow-mainnet-replay-risk` to `--allow-external-key-on-mainnet-fork` (#460) — the old flag remains as a hidden deprecated alias so existing scripts keep working — and apply the fixes left over from the 0.4.9 review (#462):

  - Enforce the Mainnet-fork replay guard (instead of warn-only) in `transfer-all`, `udt issue`, `udt destroy`, and `deploy`, and reject inputs created at or before the fork boundary in those transactions, mirroring `transfer`/`deposit`.
  - Validate `--tx-hash` as a 0x-prefixed 32-byte hex string before it is used in debug cache paths.
  - Read the fork boundary only from the spawned CKB process once it is the RPC listener, so a stale node sharing the port cannot clear the first-run flags.
  - Refuse symlinked entries when copying source chain data for a fork.
  - Accept xUDT type args longer than 32 bytes (owner lock hash plus flags/extension) while keeping SUDT at exactly 32 bytes.
  - Give SUDT and xUDT balance scans independent `maxCells` budgets, return deep clones of the default settings from `readSettings` fallbacks, keep `config set` error messages accurate, preserve the original error in `devnet config`, use `execFile` for process lookups, align the ckb-tui download timeouts, handle cross-device installs, and add the missing Fork Mainnet/Testnet entry to the README table of contents.

- 00bfe6c: Fix the devnet config editor and `status` for existing installs. The config editor's "Edit RPC Modules" dialog now offers the `Terminal` (and `RichIndexer`) modules — its option list was still the pre-ckb-tui hardcoded set, so there was no way to enable `Terminal` from the TUI even though the bundled `ckb.toml` enables it. In addition, starting the node now upgrades a legacy devnet `ckb.toml` in place: configs initialized before the ckb-tui fix never received the `Terminal` RPC module or the enabled `tcp_listen_address` (the template is only copied into fresh config folders, and clearing chain `data/` does not touch config files), which left `offckb status` dashboards empty. The migration adds `"Terminal"` to `rpc.modules` and enables `tcp_listen_address = "127.0.0.1:18114"` while preserving existing comments and custom settings; restart the node to apply.

## 0.4.9

### Patch Changes

- 6f54296: Add daemon mode and structured JSON output for agent-friendly usage, plus a `node stop` command to terminate the daemon.

  - `offckb node --daemon` starts the CKB devnet as a detached background process and writes the PID and logs to the devnet data folder.
  - `offckb --json <command>` emits structured JSON log output for programmatic consumption.
  - `offckb node stop` reads the daemon PID file and gracefully shuts down the daemon, falling back to force-kill if necessary. It now verifies the target process identity, handles stale PID files, and cleans up on error paths.
  - Hardened daemon lifecycle: duplicate daemon starts are rejected, CLI entry resolution supports packaged/npx environments via `OFFCKB_CLI_PATH`, and log/PID directory creation failures are handled gracefully.

- 8f8d0a4: Fix canary DevRel findings across daemon lifecycle, SUDT type args, fork isolation and migration, Indexer readiness, account safety, verified ckb-tui downloads, private-key input, and stable JSON command results.
- b3fe233: Add `offckb devnet fork` to fork an existing mainnet/testnet data directory into the local devnet ([Devnet From Existing Data](https://docs.nervos.org/docs/node/devnet-from-existing-data) flow), plus fork-aware system scripts and local-first debugging.

  - `offckb devnet fork --from <dir> [--source mainnet|testnet] [--spec-file <path>] [--force]` copies the source chain data, imports the matching chain spec, patches it for local mining (Dummy PoW, `cellbase_maturity = 0`, correct `genesis_epoch_length` per chain), verifies the genesis hash, and records the fork state. The first `offckb node` run boots with `--skip-spec-check --overwrite-spec` automatically; `offckb clean` resets back to a pure devnet.
  - Devnet system scripts now self-identify the chain via the genesis hash in `ckb list-hashes`: on a mainnet/testnet fork, genesis scripts come from the chain's own spec and post-genesis deployments (sudt/xudt/omnilock/spore/…) are filled from the well-known static records, so `system-scripts`, transfers, deploys and fee estimation keep working on a fork.
  - The devnet ccc client follows the forked chain too: a mainnet fork uses the `ckb` address prefix.
  - `offckb debug` falls back to fetching the transaction from the node when it is not in the local proxy cache, and the tx dumper now embeds full header objects in `mock_info.header_deps` (previously bare hashes, which broke debugging for transactions with header deps).

- 303f54e: Resolve Dependabot security alerts via pnpm overrides for transitive dependencies:

  - `qs` 6.15.0 → 6.15.2
  - `ip-address` 10.1.0 → 10.1.1
  - `js-yaml` 3.14.2 → 3.15.0 / 4.1.1 → 4.2.0
  - `@babel/core` 7.28.6 → 7.29.7
  - `@eslint/plugin-kit` 0.2.8 → 0.3.4
  - `brace-expansion` 5.0.5 → 5.0.6

  `elliptic` remains unfixed because a patched version (>=6.6.2) is not yet published on npm.

- 43ce3a3: Add `status` command to launch ckb-tui for monitoring CKB network from your node
- 463b2ff: Refactor UDT CLI support: reuse `balance` and `transfer` commands for CKB and UDT queries, and add `offckb udt issue` / `offckb udt destroy` subcommands.

## 0.4.8

### Patch Changes

- Override `form-data@>=4.0.0 <4.0.6` to `4.0.6` to fix CRLF injection (GHSA).
- Override `hono@<4.12.25` to `4.12.25` to fix CORS origin reflection with credentials.

## 0.4.7

### Patch Changes

- 1c17600: Bump @ckb-ccc/core to 1.14.0 to fix the ws vulnerability (ws >= 8.21.0).
- a687c6f: Bump default CKB version to 0.207.0
- 3da9777: Replace ckb-transaction-dumper with ccc-based implementation

  - Rewrite transaction dumper to use ccc Client and molecule codecs
  - Implement dep_group unpacking using ccc.mol
  - Remove ckb-transaction-dumper npm dependency

## 0.4.6

### Patch Changes

- a5592dc: Upgrade default CKB version from 0.201.0 to 0.205.0

  CKB v0.205.0 includes:

  - Terminal module for CKB-TUI
  - Proxy protocol support
  - RPC logs subscription
  - Rust toolchain upgrade to 1.92.0

- 8da140d: fix(cli): standardize private key inputs and fix 0x prefix parsing error (#422)
- fb506f4: fix(create): ensure CKB binary and devnet config before generating scripts

  Fix issue #396 where `offckb create` failed if user hasn't run `offckb node` first.

  **Changes:**

  - Add imports for `installCKBBinary`, `initChainIfNeeded`, and `readSettings`
  - Call `installCKBBinary` to download CKB binary if not exists
  - Call `initChainIfNeeded` to initialize devnet config if not exists
  - Both calls happen before `genSystemScriptsJsonFile` to ensure dependencies are ready

  This makes `offckb create` self-sufficient and doesn't require prior `offckb node` execution.

## 0.4.5

### Patch Changes

- 37189f7: fix(devnet): only show init hint for InitializationError

  The `offckb devnet config` command was showing the "run `offckb node` once to initialize devnet config files first" hint for ALL errors, including user input errors like invalid `--set` syntax or validation failures.

  Now the hint is only shown for actual initialization errors (missing config path, ckb.toml, or miner.toml), making error messages clearer and less misleading.

  - Added `InitializationError` class to distinguish initialization errors from user input errors
  - Updated `createDevnetConfigEditor()` to throw `InitializationError` for missing files/paths
  - Modified `devnetConfig()` catch block to only show hint for `InitializationError`
  - Added type safety guard for error handling

  Fixes #406

- e90cfe5: fix(ckb-debugger): lazy-load WASI module to suppress ExperimentalWarning

  Convert static import of node:wasi to dynamic import with caching.
  This prevents the ExperimentalWarning from being emitted when running
  non-debugger commands like 'offckb accounts' or 'offckb config list'.

  The WASI module is now only loaded when debugger functionality is
  actually executed.

  Fixes #405

- 4a88eb6: fix(install): force x86_64 architecture on Windows

  CKB only provides x86_64 binaries for Windows, not aarch64.
  When Windows ARM devices reported 'arm64' via os.arch(), the code
  tried to download a non-existent 'aarch64-pc-windows-msvc' binary,
  resulting in a 404 error.

  This fix forces all Windows systems to use x86_64, which:

  - Works correctly on Windows x64
  - Works via emulation on Windows ARM devices
  - Matches the only Windows binary CKB provides

## Changelog

All notable changes to this project will be documented in this file.
This file is automatically updated by [changesets](https://github.com/changesets/changesets).
