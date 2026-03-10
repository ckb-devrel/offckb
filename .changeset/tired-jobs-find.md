---
'@offckb/cli': patch
---

fix(install): force x86_64 architecture on Windows

CKB only provides x86_64 binaries for Windows, not aarch64.
When Windows ARM devices reported 'arm64' via os.arch(), the code
tried to download a non-existent 'aarch64-pc-windows-msvc' binary,
resulting in a 404 error.

This fix forces all Windows systems to use x86_64, which:

- Works correctly on Windows x64
- Works via emulation on Windows ARM devices
- Matches the only Windows binary CKB provides
