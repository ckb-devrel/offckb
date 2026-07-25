---
'@offckb/cli': patch
---

Change the default devnet log filter from `warn,ckb-script=debug` to `info,ckb-script=debug` in the `ckb.toml` / `ckb-miner.toml` templates (and the config editor's embedded reference templates). A healthy devnet produces almost no `warn`-level output, which left the `offckb status` Logs panel permanently empty and looked broken; `info` keeps the per-block log stream visible while `ckb-script=debug` still surfaces script execution details. Applies to newly initialized chains — edit `[logger] filter` in your existing devnet `ckb.toml` to opt in.
