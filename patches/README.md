# CKB Standalone Debugger Patches

This directory contains patches for the `ckb-standalone-debugger` submodule to add functionality that hasn't been merged upstream yet.

## Current Patches

### 0001-Add-WASM-FileOperation-syscalls-implementation.patch

**Purpose:** Adds WASM support for FileOperation syscalls to enable build mode in the WASM debugger.

**What it does:**
- Implements all file operation syscalls (`fopen`, `fread`, `fwrite`, `fclose`, etc.) for WASM target
- Adds file handle management with in-memory buffering
- Enables the WASM debugger to compile JavaScript to bytecode (build mode)
- Files are written to disk when closed (for write mode)

**Why needed:** The upstream ckb-standalone-debugger has a stub implementation for FileOperation syscalls in WASM that always returns `false`, preventing the WASM debugger from handling file operations needed for build mode.

## Usage

The patches are automatically applied during the build process via the Makefile:

```bash
# Build ckb-debugger with patches applied
make ckb-debugger

# Apply patches manually (if needed)
make apply-debugger-patches

# Clean/revert patches
make clean-debugger-patches
```

## Creating New Patches

If you need to add more changes to the ckb-standalone-debugger:

1. Make your changes in the `ckb/ckb-standalone-debugger` directory
2. Commit your changes:
   ```bash
   cd ckb/ckb-standalone-debugger
   git add -A
   git commit -m "Your change description"
   ```
3. Generate the patch:
   ```bash
   git format-patch HEAD~1 --output-directory ../../patches/
   ```
4. Update the Makefile and this README as needed

## Upstreaming

These patches should eventually be submitted to the upstream repository:
- Repository: https://github.com/nervosnetwork/ckb-standalone-debugger
- When submitting PRs, reference the specific use case (WASM build mode support)
