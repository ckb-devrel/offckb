---
'@offckb/cli': patch
---

On Windows, also place a real `ckb-debugger.exe` next to the `ckb-debugger.cmd` shim. ckb-testtool spawns `ckb-debugger` without a shell, which cannot run a `.cmd` file, so mock tests in a generated project failed with "ckb-debugger not found" even after `offckb install ckb-debugger`.
