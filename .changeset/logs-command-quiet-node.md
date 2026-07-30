---
'@offckb/cli': minor
---

Unify devnet logging around the node's log files and add `offckb logs`. A foreground `offckb node` no longer relays the raw node/miner stdout: the console now shows lifecycle events, live contract script debug output (`debug!` in scripts, streamed over the node's TCP log subscription), submitted transaction hashes, and RPC errors — the full node log stays in `data/logs/run.log` as always, and `--verbose` restores the old firehose. The new `offckb logs [node|script|miner|rpc] [-f] [--grep] [--tail]` command reads those log files (`docker logs` style), so logs are reachable in every run mode — foreground, daemon, or while `offckb status` is attached — and pipe/agent friendly. The RPC proxy is quieter too: per-request lines moved from info to debug, JSON-RPC errors in responses now surface as warnings, and everything the proxy sees is appended to `data/logs/proxy.log` (viewable via `offckb logs rpc`).
