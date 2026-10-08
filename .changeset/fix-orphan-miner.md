---
'@offckb/cli': patch
---

- node: stop the CKB node and miner when offckb exits through SIGTERM, SIGHUP, a crash or `process.exit`, and stop stale `ckb miner -C <devnet>` processes orphaned by an earlier run before starting the devnet (#512)
