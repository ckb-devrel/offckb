---
'@offckb/cli': patch
---

fix(create): ensure CKB binary and devnet config before generating scripts

Fix issue #396 where `offckb create` failed if user hasn't run `offckb node` first.

**Changes:**

- Add imports for `installCKBBinary`, `initChainIfNeeded`, and `readSettings`
- Call `installCKBBinary` to download CKB binary if not exists
- Call `initChainIfNeeded` to initialize devnet config if not exists
- Both calls happen before `genSystemScriptsJsonFile` to ensure dependencies are ready

This makes `offckb create` self-sufficient and doesn't require prior `offckb node` execution.
