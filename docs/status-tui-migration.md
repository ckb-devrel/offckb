# Status migration: blocked on a distributed TUI binary

## Decision and evidence (2026-11-17)

The migration is **not complete**. Keep `src/cmd/status.ts`, `src/tools/ckb-tui.ts`
and their tests until a pinned, distributable ckb-cli containing TUI passes the
real terminal checks below. Installing today's `tool:ckb-cli` does not enable TUI.
No runtime download/build, second status binary, npm wrapper, permission expansion
or network-context change is introduced by this follow-up.

- [offckb #548](https://github.com/ckb-devrel/offckb/pull/548) merged on
  2026-11-10 as `86592d5a1b0a985b9403aeed9bf774f4943b4286`; its final head was
  `113d4d06bf5045e9f301e5bfc4d7e66fa8a7ec32`, not the historical task commit.
  This follow-up starts from develop `7c6c9f0` and retains #546's response-draining,
  eight-request concurrency and null/omitted-params compatibility.
- [ckb-cli #683](https://github.com/nervosnetwork/ckb-cli/pull/683) merged on
  2026-09-24 as `d1e482b1318e42aadb6a89f7b2e33765e8d42763`.
- The [public releases API](https://api.github.com/repos/nervosnetwork/ckb-cli/releases?per_page=100)
  still lists [v2.0.0](https://github.com/nervosnetwork/ckb-cli/releases/tag/v2.0.0)
  (2025-12-03) as newest, including prereleases. The
  [Actions artifacts API](https://api.github.com/repos/nervosnetwork/ckb-cli/actions/artifacts?per_page=100)
  returned `total_count: 0`. No public upstream TUI artifact was found in these
  sources; private or third-party builds were not established as release inputs.
- Current upstream develop is
  [`e5b77200bc6e3f8f429e002d4c2d3173fb7fe884`](https://github.com/nervosnetwork/ckb-cli/tree/e5b77200bc6e3f8f429e002d4c2d3173fb7fe884).
  Its `Cargo.lock` pins TUI to
  [`a6b0d79613311c9404bc1a88fe421305a99beb42`](https://github.com/nervosnetwork/ckb-tui/tree/a6b0d79613311c9404bc1a88fe421305a99beb42).
  Source availability is not binary availability or terminal validation.

Recheck these endpoints before resuming. A future release must be inspected rather
than inferred from its version or from the PR's merged status.

## Existing release archive audit

All five URLs in [the descriptor](../tools/ckb-cli.json) were downloaded; archive
bytes were independently hashed and exact executable members found. Each archive
also contains `COPYING` alongside the executable. In this table, each target's
member is `ckb-cli_v2.0.0_<target>/ckb-cli` (Windows: `ckb-cli.exe`).

| Platform    | Target                    | Verified archive SHA-256                                           |
| ----------- | ------------------------- | ------------------------------------------------------------------ |
| macOS arm64 | aarch64-apple-darwin      | `e19e0fc8228e3cc9eba5e4e3506f2559a8321cf472a9f5392bc6dc4093308d06` |
| macOS x64   | x86_64-apple-darwin       | `47ab71ba16ebab79bf312e59eb547b66348a9ecf59b136909154473fb9551846` |
| Linux arm64 | aarch64-unknown-linux-gnu | `ddc3b3e08724983ee08e1b96336550e016ba0bc8156ea68e3bbe1f0f2f33f9c2` |
| Linux x64   | x86_64-unknown-linux-gnu  | `f61ea734a50f4ce91c058b92175950bcb2042847304480123f487d64214d3082` |
| Windows x64 | x86_64-pc-windows-msvc    | `74977644ac84652c8d2c7ecf983091b3ca9425c34a429eff25ebf8b01f51d2d1` |

macOS arm64 execution reports `ckb-cli 2.0.0 (80efc21 2025-12-03)`;
`--local-only tui --help` exits 2 with “subcommand 'tui' wasn't recognized”.
Other platforms were archive-audited, not executed. Windows arm64 has no descriptor
asset. Linux assets target GNU libc, not musl; minimum supported libc/OS and dynamic
libraries for a future TUI build must be measured on its actual build runners.

Repeat the download audit explicitly (Python 3 standard library only):

```sh
python3 scripts/audit-ckb-cli-release.py .prototype/ckb-cli-release-audit
```

This maintainer command never participates in plugin installation or invocation.
It writes archives, notices and a JSON audit report, without executing binaries.

ckb-cli's source license and the TUI crate's declared license are MIT. Existing
release `COPYING` contains the Nervos Foundation MIT notice. Any maintained prebuild
must include applicable copyright/permission notices and dependency notices. The
current installer copies only the executable; retaining notices in managed
installations must be resolved before distributing a new maintained TUI build.
Do not silently assume a binary-only archive satisfies redistribution conditions.

## RPC and terminal source review, not a wire trace

At the fixed source revisions above, `src/subcommands/tui.rs` accepts
`--rpc-url/-r` (overrides global `--url`), optional `--tcp-url/-t`,
`--refresh-interval/-i` (milliseconds, default 300), and `--theme-file`.
`--local-only` suppresses the CLI's two startup `get_blockchain_info` probes
(alerts and network detection); it does not disable the TUI's RPC requests.

The TUI's `src/lib.rs` probes `local_node_info`, then probes `get_overview` and
falls back when overview is unavailable. The following source call sites are all
covered by the existing broker allowlist; no extra host permission is justified:

| Method                    | Source argument shape / use                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `local_node_info`         | No arguments; startup health probe                                                              |
| `get_overview`            | Explicit `post(method, ())`; unit serializes as null, normalized by broker to `[]`              |
| `get_blockchain_info`     | No arguments; general dashboard and CLI startup                                                 |
| `get_peers`               | No arguments; peers and overview                                                                |
| `get_consensus`           | No arguments; blockchain dashboard                                                              |
| `get_tip_header`          | No arguments; dashboard refresh                                                                 |
| `get_header_by_number`    | One hexadecimal block number; first header in current epoch                                     |
| `get_fee_rate_statistics` | Optional target supplied as `None`; confirm exact wire representation with selected binary      |
| `get_cells`               | Search-key object, `"desc"`, hexadecimal limit 18 (`"0x12"`), optional cursor; live-cell search |

The SDK determines actual serialization for typed calls. Capture full JSON requests
from the selected binary before accepting this table as a tested wire contract.
Do not add blanket RPC access to accommodate an unexpected request.

Dashboard sync calls run sequentially on `dashboard-sync`; `dashboard-events`
updates state independently, and live-cell search adds a worker. TCP listeners are
conditional. This is not a measured concurrency bound: exercise startup, refresh,
all tabs and pagination against the eight-request broker and record peak in-flight
requests. Preserve large-response completion and rejection of a ninth overlapping
request in existing broker tests.

`q` calls Cursive quit. Shutdown sets a stopping flag and sends `SyncRequest::Stop`;
worker handles are not joined in `start_ckb_tui`. Source review cannot establish
raw-mode restoration, signal forwarding or process cleanup. A generic PTY fixture
passing does not validate this TUI.

## Reproducible prebuild procedure to unblock distribution

Prefer a new official release. Alternatively, an explicitly maintained prebuild
needs its own publisher, immutable HTTPS assets, provenance, notices and support
matrix. None has been published or selected by this change. The following is a
fixed-input build recipe, **not a claim of bit-for-bit reproducibility or a tested
build**. Run during release preparation, never when a user invokes status:

```sh
# Inside a scratch directory in the task worktree:
git clone https://github.com/nervosnetwork/ckb-cli.git ckb-cli-source
cd ckb-cli-source
git checkout --detach e5b77200bc6e3f8f429e002d4c2d3173fb7fe884
test "$(git rev-parse HEAD)" = e5b77200bc6e3f8f429e002d4c2d3173fb7fe884
rustup toolchain install 1.95.0 --profile minimal
cargo +1.95.0 fetch --locked
# Set TARGET to the native runner's target from the matrix below.
rustup target add --toolchain 1.95.0 "$TARGET"
cargo +1.95.0 build --locked --release --target "$TARGET" --bin ckb-cli
git diff --exit-code -- Cargo.lock
# Run the resulting binary on that target:
target/"$TARGET"/release/ckb-cli --version
target/"$TARGET"/release/ckb-cli --local-only tui --help
# Windows binary path ends in ckb-cli.exe; use its native shell equivalent.
```

| Native runner         | TARGET                                               | Build prerequisites to record                                                    |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| macOS arm64 / x64     | aarch64-apple-darwin / x86_64-apple-darwin           | Xcode command-line tools, SDK and deployment target                              |
| Linux arm64 / x64 GNU | aarch64-unknown-linux-gnu / x86_64-unknown-linux-gnu | C/C++ compiler, pkg-config, OpenSSL development files, chosen libc baseline      |
| Windows x64           | x86_64-pc-windows-msvc                               | Visual Studio C++ build tools and Windows SDK; verify OpenSSL build requirements |

The pinned lockfile includes OpenSSL and Cursive's crossterm backend. Record exact
runner image/tool versions, compiler/linker flags and linked libraries (`otool -L`,
`ldd`/`readelf`, `dumpbin /DEPENDENTS`). Do not reuse upstream package workflow's old
Rust 1.75 builder images: this source pins 1.95 and TUI uses edition 2024.
Use native runners initially rather than promising untested cross compilation.

Package a regular executable plus notices per target; inspect archive members and
hash **finished archive bytes** with SHA-256. Publish immutable HTTPS assets, then
download and rehash each before filling a descriptor. Preserve the same ckb-cli
identity/command and persistent storage. A local linked build can be used for TTY
investigation, but cannot satisfy a publicly installable `tool:ckb-cli` migration.

## Implementation and acceptance after an artifact exists

1. Update the single ckb-cli descriptor with verified artifacts and notices. Confirm
   `offckb ckb-cli --local-only tui` uses the supplied read-only devnet gateway and
   persistent `CKB_CLI_HOME`. Inspect and test endpoint overrides: the CLI's global
   `--url` and TUI `--rpc-url` must not let the status alias silently select a
   different chain. Do not grant arbitrary sandbox networking.
2. Delegate installed `offckb status` through the existing plugin lifecycle,
   preserving its TTY check and child exit behavior. For absent installations,
   print `offckb plugin install tool:ckb-cli --allow devnet-read`; on Windows append
   `--trust`. Do not print that as a way to obtain TUI while v2.0.0 is pinned.
   Test absent/stale/invalid registrations, exact argv, non-TTY and nonzero exits.
3. Initial migration is devnet-only. Explicitly reject status `--network testnet`
   and `--network mainnet` before plugin execution with an actionable explanation;
   do not map them to devnet. Until migration, the legacy status continues to use
   the requested network's existing proxy and readiness check.
4. Omit TCP endpoints in sandbox mode. Explain that pushed latest/rejected
   transactions and live logs are unavailable; HTTP dashboards remain available.
   No trusted TCP binding is proposed: context currently supplies no endpoint.
5. Run the actual selected TUI in a PTY on macOS sandbox-exec and Linux bubblewrap,
   with trusted mode as control. Assert stdin/stdout TTY, raw-mode entry, navigation,
   refresh and cell search, `q` exit, Ctrl-C, external SIGTERM, restored terminal
   flags, propagated exit codes and absence of surviving child processes. Repeat
   with RPC startup failure and slow/large responses. Windows supports explicit
   trusted execution only and needs native console validation.
6. Run broker/plugin/explorer regressions, typecheck, lint, build and production
   smoke. Then remove the replaced ckb-tui installer/config/tests, update status
   documentation and add the migration changeset. Preserve JS/npm/GitHub plugin,
   context, read-RPC and HTTP serve compatibility. No account/signing/write RPC or
   PATH shim is part of this scope.

## Validation recorded for this follow-up

Local host: macOS arm64, Node 24.8.0, pnpm 10.28.2.

- All five platform archive digests and executable members matched the descriptor;
  the local v2.0.0 missing-TUI probe exited 2 as recorded above.
- `pnpm test --runInBand`: 64 suites passed, 724 tests passed, 7 skipped.
- `pnpm typecheck` and `pnpm build`: passed. `pnpm lint`: passed with the existing
  `no-explicit-any` warning in `src/node/install.ts:182`.
- `node scripts/plugin-binary-smoke.mjs`, with and without `--sandbox`: passed,
  including generic native PTY inheritance and raw-mode ioctl.
- The same production smoke with `--ckb-cli-archive` pointing to the verified
  official macOS arm64 archive passed in trusted and sandbox modes: installation,
  help, read RPC, write denial and removal. This tests v2.0.0, which has no TUI.

Existing CI config runs generic sandbox smoke on macOS and Ubuntu 24.04; it contains
no real integrated TUI test. No Linux/Windows binary execution, TUI build, real TUI
terminal/signal test or migrated-status test is claimed.
