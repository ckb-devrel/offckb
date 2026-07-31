---
'@offckb/cli': patch
---

Fix review findings from the v0.4.11 release merge. `offckb logs script` now scans a wider window before filtering so sparse script entries are not missed, and an unknown `offckb logs` target is rejected instead of silently reading the node log. `offckb logs -f` detects log rotation by inode change, so a rotated-in file that is already larger than the old one is re-read from the start. CKB 0.205.0 prerelease binaries (rc builds) are now correctly treated as Terminal-RPC capable during chain init. A ckb-tui binary that lost its execute bit is reinstalled instead of failing at spawn time. The RPC proxy keeps appending events when a proxy.log rollover fails (previously all further events were dropped), records batched JSON-RPC requests including batched `send_transaction`, and warns instead of misreporting a parse error when `send_transaction` has no usable params. `--verbose` on `offckb node` now also enables the proxy's per-request debug lines.
