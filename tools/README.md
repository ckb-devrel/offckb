# Bundled native tool descriptors

These files are the official binary tool catalog: one pinned descriptor per tool. The catalog
is the only first-party binary source; nothing here installs automatically. See
[binary tools](../docs/binary-tools.md) for how users install from it, and
[plugins](../docs/plugins.md) for the whole plugin surface.

`ckb-cli.json` was the first descriptor; `ckb-debugger.json` joined when the catalog absorbed
the old release-template entries. Each pins official release assets, their archive members and
SHA-256 values, plus argument/environment bindings. Updating a pin does not require
installer/runner changes. To add a tool, add its JSON file and one line in
`src/plugins/catalog.ts` (a static import keeps the descriptor in the production bundle).

Verify each platform's actual archive, executable member, runtime requirements and checksum when updating. Keep Windows `.exe` selection in its platform asset; the installer chooses the installed filename. Preserve the tool's stable `name` so upgrades retain its data/cache. Test actual binary behavior in its native (trusted) execution mode. Never substitute guessed release URLs, unpinned latest assets, or installation scripts for unavailable upstream artifacts.
