---
'@offckb/cli': patch
---

- accounts: print dev private keys by default (#520). OffCKB is a local testing tool and these are publicly known devnet-only keys, so hiding them behind an extra flag was unnecessary. A new `--hide-private-keys` option omits them from the output, and the old `--show-private-keys` flag is kept as a deprecated no-op so existing scripts keep working.
