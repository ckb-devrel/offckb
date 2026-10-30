---
'@offckb/cli': patch
---

Fix the DEP0040 punycode deprecation warning when starting the CLI on recent Node.js versions, including `offckb fiber status`. Patch the legacy node-fetch URL dependencies to use the userland punycode module while preserving HTTP proxy support.
