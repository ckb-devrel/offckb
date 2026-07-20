---
'@offckb/cli': minor
---

Add `offckb devnet fork` to fork an existing mainnet/testnet data directory into the local devnet ([Devnet From Existing Data](https://docs.nervos.org/docs/node/devnet-from-existing-data) flow), plus fork-aware system scripts and local-first debugging.

- `offckb devnet fork --from <dir> [--source mainnet|testnet] [--spec-file <path>] [--force]` copies the source chain data, imports the matching chain spec, patches it for local mining (Dummy PoW, `cellbase_maturity = 0`, correct `genesis_epoch_length` per chain), verifies the genesis hash, and records the fork state. The first `offckb node` run boots with `--skip-spec-check --overwrite-spec` automatically; `offckb clean` resets back to a pure devnet.
- Devnet system scripts now self-identify the chain via the genesis hash in `ckb list-hashes`: on a mainnet/testnet fork, genesis scripts come from the chain's own spec and post-genesis deployments (sudt/xudt/omnilock/spore/…) are filled from the well-known static records, so `system-scripts`, transfers, deploys and fee estimation keep working on a fork.
- The devnet ccc client follows the forked chain too: a mainnet fork uses the `ckb` address prefix.
- `offckb debug` falls back to fetching the transaction from the node when it is not in the local proxy cache, and the tx dumper now embeds full header objects in `mock_info.header_deps` (previously bare hashes, which broke debugging for transactions with header deps).
