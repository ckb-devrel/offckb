---
'@offckb/cli': minor
---

Add `offckb install ckb-debugger` to install the native `ckb-debugger` binary. Instead of compiling from source with `cargo install` (which needs a Rust toolchain), offckb now downloads the prebuilt release asset for the current platform from the official ckb-standalone-debugger GitHub releases, verifies its SHA-256 digest, publishes it under the offckb data directory, and puts a `ckb-debugger` shim next to the offckb binary so generated projects can find it on PATH. `offckb create` installs the native debugger automatically when it is missing. The bundled WASM debugger and its fallback logic have been removed — `offckb debug` now requires the native binary. Version checks against the configured minimum now compare numerically, so an installed binary that satisfies `tools.ckbDebugger.minVersion` is correctly recognized.
