---
'@offckb/cli': patch
---

- plugins: stop isolated plugin homes (`OFFCKB_PLUGIN_HOME`) from writing PATH shims into the real global bin directory — their shims now live under `<home>/bin`, so temporary homes can no longer plant dangling shims that shadow user binaries. Shims whose owning home provably no longer exists are reclaimed by any live home's install/remove (including `plugin remove` for an unregistered command), and shim scripts now report an actionable error and exit 127 when their managed binary is missing instead of a bare shell "no such file"
