---
'@offckb/cli': patch
---

- accounts: print the built-in dev private keys by default on a local devnet; add `--hide-private-keys` to omit them. Mainnet forks still hide keys unless `--show-private-keys` is passed (#520)
