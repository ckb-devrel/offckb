---
"@offckb/cli": patch
---

Add daemon mode and structured JSON output for agent-friendly usage, plus a `node stop` command to terminate the daemon.

- `offckb node --daemon` starts the CKB devnet as a detached background process and writes the PID and logs to the devnet data folder.
- `offckb --json <command>` emits structured JSON log output for programmatic consumption.
- `offckb node stop` reads the daemon PID file and gracefully shuts down the daemon, falling back to force-kill if necessary.
