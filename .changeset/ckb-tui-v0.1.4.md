---
'@offckb/cli': patch
---

Bump the bundled ckb-tui from v0.1.3 to v0.1.4 for `offckb status`. The new release fixes a divide-by-zero panic in ckb-tui's data-sync thread when the connected node has no peers (Officeyutong/ckb-tui#13) — the normal state of a single-node devnet — which permanently froze the Overview, Mempool, Peers, and Blockchain panels within seconds of opening the TUI. SHA-256 digests for the v0.1.4 release assets are pinned in offckb, so the download stays verifiable.
