---
'@offckb/cli': patch
---

Rename `--allow-mainnet-replay-risk` to `--allow-external-key-on-mainnet-fork` (#460) and apply the fixes left over from the 0.4.9 review (#462):

- Enforce the Mainnet-fork replay guard (instead of warn-only) in `transfer-all`, `udt issue`, `udt destroy`, and `deploy`, and reject inputs created at or before the fork boundary in those transactions, mirroring `transfer`/`deposit`.
- Validate `--tx-hash` as a 0x-prefixed 32-byte hex string before it is used in debug cache paths.
- Read the fork boundary only from the spawned CKB process once it is the RPC listener, so a stale node sharing the port cannot clear the first-run flags.
- Refuse symlinked entries when copying source chain data for a fork.
- Accept xUDT type args longer than 32 bytes (owner lock hash plus flags/extension) while keeping SUDT at exactly 32 bytes.
- Give SUDT and xUDT balance scans independent `maxCells` budgets, return deep clones of the default settings from `readSettings` fallbacks, keep `config set` error messages accurate, preserve the original error in `devnet config`, use `execFile` for process lookups, align the ckb-tui download timeouts, handle cross-device installs, and add the missing Fork Mainnet/Testnet entry to the README table of contents.
