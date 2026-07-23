---
"@offckb/cli": patch
---

Fix the `status` command showing missing data on devnet: enable the Terminal RPC module and the TCP listen address in the devnet `ckb.toml` template, and pass the node's TCP listen address to ckb-tui so the system metrics, mempool, and log panels populate correctly.
