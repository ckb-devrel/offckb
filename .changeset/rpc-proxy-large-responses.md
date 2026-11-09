---
'@offckb/cli': patch
---

Preserve large plugin RPC responses through the sandbox proxy by length-delimiting successful responses and allowing a short drain grace before closing the connection. Raise the default read-RPC concurrency allowance from four to eight for normal development-tool page bursts while retaining bounded connections, request lifetime and payload sizes.
