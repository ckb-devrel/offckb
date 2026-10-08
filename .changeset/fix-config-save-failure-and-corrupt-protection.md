---
'@offckb/cli': patch
---

Fix #518: Propagate settings read/write failures and prevent overwriting corrupted config files.

- Configuration mutation commands (`offckb config set` and `offckb config rm`) now perform strict reading (`readSettingsStrict`). If `settings.json` cannot be read, parsed, or validated, the modification aborts immediately, throwing an Error with the file path and reason while leaving the existing file contents intact.
- Missing configuration files (ENOENT) continue to fall back to default settings, allowing initial creation.
- Non-mutating `readSettings()` continues to fall back to default settings on exceptions, preserving existing read-only behavior across the project.
- `writeSettings` now writes atomically to a unique temporary file in the same directory and replaces the target via `renameSync`, cleaning up temporary files on error.
- `writeSettings` throws an Error containing the config file path and underlying error instead of swallowing it, allowing the CLI error handling to exit with a non-zero exit code and emit structured `ok: false` in JSON mode.
