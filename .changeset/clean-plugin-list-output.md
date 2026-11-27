---
'@offckb/cli': patch
---

Make `offckb plugin list` easier to scan by grouping JavaScript plugins and binary tools and showing clear installed and available statuses. Catalog tools stay visible when a JavaScript plugin uses the same command name, with a message explaining why installation is blocked. Full source details remain available with `offckb --json plugin list`.
