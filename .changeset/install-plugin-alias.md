---
'@offckb/cli': patch
---

Make `offckb install <source>` a full alias of `offckb plugin install <source>`: the top-level command now accepts every plugin install source (npm package, `github:owner/repo[#ref]`, catalog tool name, local binary directory) and the same options (`--trust`, `--allow`, `--read`, `--allow-scripts`), going through the shared installer, permission consent, logging and JSON result. The lenient `tools.ckbDebugger.minVersion` short-circuit stays only in the `offckb create` flow, so creating a project never force-upgrades an existing debugger. Docs updated to match: uninstall via `offckb plugin remove`, and the catalog `@latest` pin semantics.
