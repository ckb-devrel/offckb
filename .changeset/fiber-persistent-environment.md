---
'@offckb/cli': minor
---

Prepare Fiber devnets with optional `fiber init`, persistent full node configs, explicit funding-account bindings and per-node RPC management tokens. Direct starts still initialize new environments automatically; subsequent starts preserve configs and data and reuse the saved program. Add nodes with `fiber init --add`, including unfunded random accounts. Status reports custom configs and distinguishes authentication failures from stopped nodes.

Clarify that stop/start preserves data while clean commands reset it; devnet config editing no longer recommends deleting chain and Fiber stores for normal runtime changes. The unreleased legacy Fiber configuration format is not migrated.
