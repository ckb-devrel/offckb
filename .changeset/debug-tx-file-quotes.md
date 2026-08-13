---
'@offckb/cli': patch
---

Fix `offckb debug` failing with `ENOENT` on the tx-file path. The debugger now splits its command line quote-aware, so the quotes `encodeBinPathForTerminal` adds around space-containing paths are stripped instead of becoming part of the file name (a regression from the native ckb-debugger switch, which passes array argv to `execFileSync` instead of a shell string).
