---
'@offckb/cli': minor
---

Add binary tool plugins (`kind: "binary"`): offckb now manages native binaries (starting with ckb-debugger) in the plugin registry with one lifecycle — install/update/remove/list — plus a stable path per tool, PATH shims with ownership markers (including a real `.exe` on Windows), and `OFFCKB_TOOL_<COMMAND>` env export via `offckb plugin which` / `offckb plugin env`. Third-party binary sources must pass the local trusted-source allowlist (`offckb plugin trust add|list|remove`, or `--trust-source` at install); the first-party catalog is implicitly trusted. Existing ckb-debugger installs are adopted without re-downloading, `offckb install ckb-debugger` stays as an alias, and `offckb debugger` argument passthrough is fixed.
