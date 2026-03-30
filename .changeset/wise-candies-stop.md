---
'@offckb/cli': minor
---

Replace ckb-transaction-dumper with ccc-based implementation

- Rewrite transaction dumper to use ccc Client and molecule codecs
- Implement dep_group unpacking using ccc.mol
- Remove ckb-transaction-dumper npm dependency
