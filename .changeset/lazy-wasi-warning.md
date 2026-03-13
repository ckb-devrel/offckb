---
'@offckb/cli': patch
---

fix(ckb-debugger): lazy-load WASI module to suppress ExperimentalWarning

Convert static import of node:wasi to dynamic import with caching.
This prevents the ExperimentalWarning from being emitted when running
non-debugger commands like 'offckb accounts' or 'offckb config list'.

The WASI module is now only loaded when debugger functionality is
actually executed.

Fixes #405
