# @offckb/cli

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
