---
'@offckb/cli': patch
---

fix(devnet): only show init hint for InitializationError

The `offckb devnet config` command was showing the "run `offckb node` once to initialize devnet config files first" hint for ALL errors, including user input errors like invalid `--set` syntax or validation failures.

Now the hint is only shown for actual initialization errors (missing config path, ckb.toml, or miner.toml), making error messages clearer and less misleading.

- Added `InitializationError` class to distinguish initialization errors from user input errors
- Updated `createDevnetConfigEditor()` to throw `InitializationError` for missing files/paths
- Modified `devnetConfig()` catch block to only show hint for `InitializationError`
- Added type safety guard for error handling

Fixes #406
