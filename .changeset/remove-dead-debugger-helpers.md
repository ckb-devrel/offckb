---
'@offckb/cli': patch
---

Remove dead debugger helpers left over from the pre-plugin install path: `buildContract` in `src/cmd/debug.ts` (no callers anywhere; generated projects ship their own `scripts/build-contract.js` that spawns `ckb-debugger` from PATH) and `CKBDebugger.runTxCellScript` with its `DebugOption` type (superseded by `runRaw`/`runWithArgs`). No behavioral change.
