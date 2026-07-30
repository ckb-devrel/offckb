---
'@offckb/cli': patch
---

Fix upgraded installs staying on an old bundled ckb-tui. Releases up to 0.4.10 wrote the entire merged settings object on any `offckb config set` (proxy or ckb-version), freezing the then-current bundled ckb-tui version (v0.1.3) into `settings.json`. After upgrading offckb, that frozen value overrode the new shipped default, so affected users never moved to v0.1.4 — and the stale-binary digest check compares against the configured version, so it never triggered a reinstall for them either. `readSettings` now upgrades a persisted ckb-tui version that is older than the shipped default (a newer hand-set version is still respected), and `writeSettings` no longer persists the version when it merely equals the default.
