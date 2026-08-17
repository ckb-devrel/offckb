---
'@offckb/cli': patch
---

Fix two CLI UX bugs reported in #498:

- `offckb balance` without an address no longer leaks the SDK's `Unknown address format undefined`. The address argument is now required, so commander prints a clear `error: missing required argument 'toAddress'`.
- Commander parameter/option errors (unknown option, invalid option value, missing argument) are printed exactly once on stderr instead of twice.
