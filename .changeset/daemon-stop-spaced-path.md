---
'@offckb/cli': patch
---

- daemon: identify a running offckb daemon by anchoring the node executable and CLI script path in the process command line, so `offckb node stop` works when the CLI path contains spaces (e.g. macOS `~/Library/Application Support/...`)
