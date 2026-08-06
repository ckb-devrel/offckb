---
'@offckb/cli': minor
---

Add `offckb install ckb-debugger` to install the native `ckb-debugger` binary. Instead of compiling from source with `cargo install` (which needs a Rust toolchain), offckb now downloads the prebuilt release asset for the current platform from the official ckb-standalone-debugger GitHub releases, verifies its SHA-256 digest, publishes it under the offckb data directory, and puts a `ckb-debugger` shim next to the offckb binary so generated projects can find it on PATH. `offckb create` now installs the native debugger automatically when it is missing, falling back to the built-in WASM debugger when the download is unavailable (e.g. offline). Version checks against the configured minimum now compare numerically, so an installed binary that satisfies `tools.ckbDebugger.minVersion` is correctly recognized.
