---
'@offckb/cli': minor
---

Add binary tool plugins (`kind: "binary"`): offckb manages native binaries (starting with ckb-debugger and ckb-cli) in the plugin registry with one lifecycle — install/update/remove/list — a stable path per tool, PATH shims with ownership markers (including a real `.exe` on Windows), and `OFFCKB_TOOL_<COMMAND>` env export via `offckb plugin which` / `offckb plugin env`. Binary tools come from the official catalog (pinned per-platform descriptors in `tools/`, reviewed with each release) or from a local directory via `offckb plugin install ./dir`; they always run natively with the user permissions. `offckb plugin list` shows the catalog with check marks. Existing ckb-debugger installs are adopted without re-downloading, `offckb install ckb-debugger` stays as an alias, and `offckb debugger` argument passthrough is fixed.
