# Bundled native tool descriptors

These optional descriptions use the same [public protocol](../docs/binary-tools.md) as local and third-party HTTPS descriptions. Bundling a descriptor does not install a tool, reserve its command or authorize any capability. Third parties need no entry here.

`ckb-cli.json` is the first descriptor. It pins official release assets, their archive members and SHA-256 values, plus argument/environment bindings. Updating it does not require installer/runner changes. To add another convenience name, add its JSON file and register it in `src/plugins/bundled-tools.ts` (a static import keeps the descriptor in the production bundle).

Verify each platform's actual archive, executable member, runtime requirements and checksum when updating. Keep Windows `.exe` selection in its platform asset; the installer chooses the installed filename. Preserve the tool's stable `name` so upgrades retain its data/cache. Test actual binary behavior under both trusted and supported sandbox modes. Never substitute guessed release URLs, unpinned latest assets, or installation scripts for unavailable upstream artifacts.
