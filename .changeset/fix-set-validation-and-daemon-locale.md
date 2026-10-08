---
'@offckb/cli': patch
---

- devnet config: include field name, rejected value, and original validation reason when `--set` validation fails (#516)
- daemon: run posix `ps` process probes with `LC_ALL=C` so daemon start time parsing succeeds under non-English locales (#519)
