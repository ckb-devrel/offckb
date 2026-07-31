---
---

Add a legacy-data upgrade-path integration test (`scripts/legacy-data-test.sh`) and run it in CI on Ubuntu: data created by an old offckb release (0.3.4, CKB 0.113.1) must keep working with the current build — the chain continues from the old tip with the genesis hash unchanged, the legacy ckb.toml is migrated (Terminal RPC module + tcp_listen_address), the bundled chain spec is left untouched, and a fresh transfer is committed. CI and test infrastructure only; no runtime changes.
