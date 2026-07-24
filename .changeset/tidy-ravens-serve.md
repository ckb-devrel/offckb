---
'@offckb/cli': patch
---

Fix the devnet config editor and `status` for existing installs. The config editor's "Edit RPC Modules" dialog now offers the `Terminal` (and `RichIndexer`) modules — its option list was still the pre-ckb-tui hardcoded set, so there was no way to enable `Terminal` from the TUI even though the bundled `ckb.toml` enables it. In addition, starting the node now upgrades a legacy devnet `ckb.toml` in place: configs initialized before the ckb-tui fix never received the `Terminal` RPC module or the enabled `tcp_listen_address` (the template is only copied into fresh config folders, and clearing chain `data/` does not touch config files), which left `offckb status` dashboards empty. The migration adds `"Terminal"` to `rpc.modules` and enables `tcp_listen_address = "127.0.0.1:18114"` while preserving existing comments and custom settings; restart the node to apply.
