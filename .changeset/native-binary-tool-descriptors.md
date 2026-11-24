---
'@offckb/cli': minor
---

The official binary tool catalog now uses pinned per-platform descriptors (`tools/*.json`): every catalog entry declares exact asset URLs, SHA-256 digests, archive members and argument/environment bindings as data, reviewed with each offckb release. Binary tools install from the catalog by name or from a local directory (`offckb plugin install ./dir`, a managed copy of the declared executable), always run natively with the user permissions, and never execute during installation. `offckb plugin list` shows the catalog with check marks for installed tools.
