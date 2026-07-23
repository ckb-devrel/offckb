---
'@offckb/cli': patch
---

Fix the `status` command showing missing data on devnet: enable the Terminal RPC module and the TCP listen address in the devnet `ckb.toml` template, and pass the node's TCP listen address to ckb-tui so the system metrics, mempool, and log panels populate correctly. The devnet RPC now binds to `127.0.0.1` instead of `0.0.0.0` so the unauthenticated RPC (including the new host metrics) is no longer reachable from other machines on the network; edit `rpc.listen_address` in the devnet `ckb.toml` if you rely on remote access.
