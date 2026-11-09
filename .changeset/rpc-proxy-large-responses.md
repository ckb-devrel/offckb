---
'@offckb/cli': patch
---

Preserve large plugin RPC responses through the sandbox proxy by length-delimiting successful responses and allowing a short drain grace before closing the connection.
