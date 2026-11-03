---
'@offckb/cli': minor
---

Add experimental local tool plugins with one-command npm/GitHub install, managed replacement/removal and local link/list/unlink commands, static manifest validation, versioned devnet context, opaque argument forwarding and foreground process cleanup. Default to OS sandboxing on macOS/Linux; allow explicitly trusted packages to run natively on Windows/macOS/Linux without WSL or sandbox setup. Show the execution mode and retain environment filtering and host-provided read-RPC/HTTP capabilities in both modes, without claiming OS isolation for trusted execution. Include a generic context probe and protocol/security tests; install scripts are disabled by default, with explicit trusted build consent. Ship a fixed npm CLI for consistent preparation behavior on Node 20 and Windows. Background services and automatic upgrades remain deferred.
