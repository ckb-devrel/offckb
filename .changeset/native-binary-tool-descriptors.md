---
'@offckb/cli': minor
---

The official binary tool catalog now uses pinned per-platform descriptors (`tools/*.json`): every catalog entry declares exact asset URLs, SHA-256 digests, archive members and argument/environment bindings as data, reviewed with each offckb release. Binary tools install from the catalog by name or from a local directory (`offckb plugin install ./dir`, a managed copy of the declared executable), always run natively with the user permissions. Downloaded binaries are verified against their pinned SHA-256 and are never executed during installation; the one-shot legacy adoption of a pre-plugin install probes the existing binary's own version report. `offckb plugin list` shows the catalog with check marks for installed tools.
