---
'@offckb/cli': patch
---

Fix devnet startup crashing for CKB binaries older than v0.205.0. The devnet ckb.toml template enables the `Terminal` RPC module, which only exists since CKB v0.205.0; older binaries abort at startup with an opaque serde "unknown variant" error, and the legacy-config migration re-added the module on every `offckb node` start even after users removed it by hand. offckb now adapts the devnet config to the CKB version: fresh chains for an old binary are initialized without `Terminal` (the migration also stops re-adding it, while still enabling `tcp_listen_address`), a config that already has `Terminal` paired with an old binary fails fast with an actionable error instead of the serde dump, and an unprobeable custom `--binary-path` that crashes with the tell-tale "unknown variant `Terminal`" message now gets a hint pointing at the cause. The `offckb status` system-metric panels require CKB >= 0.205.0; the README's `status` section says so.
