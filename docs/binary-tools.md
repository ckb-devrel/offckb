# Native binary plugins

Native tools use the same registration, grants, storage, foreground lifecycle and OS sandbox as JavaScript plugins. They need no npm package, JavaScript entry, install script or upstream repository changes. Node is still required by offckb and its sandbox launcher.

## Install and update

```sh
# Optional descriptor shipped with offckb. Nothing is installed automatically.
offckb plugin install tool:ckb-cli --allow devnet-read
# Third-party descriptor: no offckb PR or catalog registration required.
offckb plugin install https://example.org/releases/my-tool.json --allow devnet-read
# Local descriptor: install a managed copy of the selected download.
offckb plugin install ./my-tool.json --allow devnet-read
# Local directory containing offckb-tool.json and its executable: no download/copy.
offckb plugin link ./my-tool --allow devnet-read
offckb plugin list
offckb my-tool --help
offckb plugin remove my-tool
```

Windows requires explicit `--trust` at installation/linking. Other platforms default to sandbox execution with the prerequisites in [plugins.md](plugins.md). Trust is a user decision, never a descriptor field. Native tools reject `--allow-scripts` in both modes.

`tool:<name>` is a convenience source, not a requirement for participation. Otherwise supply a local `.json` file or HTTPS URL ending in `.json`. Raw GitHub descriptor URLs work; GitHub repository URLs still select npm-shaped source installation. Existing npm/GitHub packages continue to work.

The installer validates metadata, platform, grants and core-command conflicts; downloads the selected asset; checks its pinned SHA-256; and copies only the declared executable into a fresh managed directory. It never runs the executable during installation. Failed preparation preserves the previous installation. Replacement/removal reuses registry locks, ownership checks and foreground leases. Data/cache survive upgrades/removal. Linked directories remain user-owned and are never deleted.

The normalized descriptor and asset digests are saved locally as `offckb-tool.json`. Provenance records the source, version and normalized source-descriptor SHA-256. Runtime never re-fetches a remote description. Reinstall explicitly to update and regrant capabilities. Installed files, like existing local JavaScript packages, are mutable and are not rehashed on every invocation. A third party's checksum detects changed bytes relative to its descriptor, not independent publisher authenticity.

Limits: descriptor 1 MiB; download 128 MiB; executable 256 MiB; expanded archive 512 MiB; five HTTPS redirects; two-minute download deadline including body reads. Input URLs cannot contain credentials, queries or fragments. Signed HTTPS release redirects are accepted but never persisted. Authenticated/private artifact services and custom download headers are outside v1.

## Descriptor v1

This is a template: replace the URL and checksum with a real fixed release and verified digest.

```json
{
  "apiVersion": 1,
  "name": "my-native-tool",
  "version": "1.2.3",
  "command": "my-tool",
  "description": "My native development tool",
  "entry": "bin/my-tool",
  "permissions": ["devnet-read"],
  "execution": {
    "args": ["--rpc", "${devnet.rpcUrl}"],
    "env": {"MY_TOOL_HOME": "${plugin.dataPath}"}
  },
  "platforms": {
    "linux-x64": {
      "url": "https://example.org/releases/v1.2.3/my-tool.tar.gz",
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS",
      "format": "tar.gz",
      "executable": "my-tool-v1.2.3/my-tool"
    }
  }
}
```

- `name`: stable package-shaped identity, optionally scoped; owns storage across versions. A different identity cannot take over an existing command without explicit removal.
- `version`: exact semver. `command`: existing plugin command rules; core commands and unrelated registrations cannot be overwritten.
- `entry`: relative regular executable inside the linked directory. Managed installations rewrite this to `bin/<command>` (`bin/<command>.exe` on Windows). POSIX files must be executable; Windows entries must be `.exe`. Escaping symlinks are rejected. There is no ambient PATH search or implicit adoption of user installations.
- `permissions`: existing `devnet-read`, `project-deployment`, `serve` grants. Every requested capability requires explicit authorization. Entry type confers no extra filesystem/network privileges.
- `execution`: optional; omitted `args` and `env` each default independently to an empty array/object, so args-only and env-only configurations are supported. Fixed arguments precede the user's exact argument array, without a shell. Substitutions are limited to `${devnet.rpcUrl}`, `${plugin.dataPath}`, `${plugin.cachePath}`, `${cwd}`. RPC substitution requires `devnet-read`. Runtime/loader/proxy environment variables cannot be overridden.
- `platforms`: required for installation, optional for local links. Keys are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`. Missing means unsupported. Linux publishers must select an appropriate libc/minimum-OS baseline; v1 does not detect musl or emulate architectures.
- Assets: exact HTTPS URL, lowercase SHA-256, `format` (`raw`, `zip`, `tar.gz`) and exact regular-file archive member `executable`. Only that member is copied, never an archive directory tree. Symlinks/hardlinks are rejected. Shared-library bundles, multi-file runtimes and arbitrary install/build hooks are outside v1.

The working directory is the tool's directory. `${cwd}` identifies the caller's project but grants no access. Inputs still require read grants; generic project output writes are not currently supported. Store configuration in the supplied persistent data directory, without assuming access to the user's wallets, HOME or inherited credentials. Context-aware native programs can read `OFFCKB_PLUGIN_CONTEXT`; existing programs can use bindings.

Standalone `--help`/`-h` skips context and fixed arguments, with temporary storage bindings. Mixed help follows normal preparation. The tool owns output and exit codes; native output is not converted to offckb JSON. Network clients must honor the sandbox's HTTP proxy; a native entry does not automatically make a non-proxy-aware client compatible. Raw TCP subscriptions remain unavailable in sandbox mode.

## First descriptor: ckb-cli

[tools/ckb-cli.json](../tools/ckb-cli.json) pins [official v2.0.0 release archives](https://github.com/nervosnetwork/ckb-cli/releases/tag/v2.0.0) for macOS arm64/x64, Linux arm64/x64 (GNU libc) and Windows x64. Digests come from official release metadata. Bindings supply the read-only devnet gateway through `--url` and independent persistent storage through `CKB_CLI_HOME`; existing accounts and keys are not imported.

```sh
offckb plugin install tool:ckb-cli --allow devnet-read
offckb ckb-cli --help
offckb ckb-cli --local-only rpc get_tip_block_number
offckb ckb-cli --local-only util --help
```

`--local-only` skips ckb-cli startup alert/network probes; explicitly requested RPCs still use the gateway. This integration supports permitted read RPCs and offline operations within granted paths. Installing the complete executable does not grant write/admin RPCs, project writes, signing integration, public-network routing or compatible scripts for every custom chain. Trusted mode still supplies a read-only gateway, although trusted code has independent OS/network access.

The integrated `ckb-cli tui` is [merged upstream](https://github.com/nervosnetwork/ckb-cli/pull/683), but published v2.0.0 does **not** contain it. Core `offckb status` and its legacy ckb-tui installer remain operational; no stub points to an unpublished npm package. Switching status awaits a pinned ckb-cli artifact containing TUI plus an actual TUI RPC/TTY test. No speculative release URLs/digests or automatic source builds are used. A future descriptor update need not change the generic installer.

## Feasibility and host changes

| Area | Result and boundary |
| --- | --- |
| Native entry and installation | Implemented independently of npm; bundled/local/third-party descriptors share validation, pinned downloads and managed ownership. |
| RPC | Real v2.0.0 queries work through the broker after normalizing Rust's `params: null`. `devnet-read` also permits `local_node_info`, `get_consensus`, `sync_state`, `get_peers`, `get_overview` for local node inspection; no separate node-info grant or write grant is introduced. A future integrated TUI artifact still needs its full RPC sequence tested. |
| Terminal | Native entries inherit stdio. Real macOS sandbox/trusted PTY raw-mode tests pass with PTY allowed. Linux checks are added to CI; Windows requires trusted execution. This is not a claim that the unreleased integrated TUI has been tested. |
| TCP subscriptions | No raw TCP grant is added. The future TUI's TCP option must be omitted in sandbox mode, losing pushed transaction/log data. Trusted users retain independent OS networking, but the current context supplies no TCP endpoint. |
| Distribution | Direct verified Release assets replace the need for platform npm wrappers. npm/GitHub JavaScript plugins remain supported. No runtime downloads or installation scripts execute inside a plugin. |
| Networks and accounts | Context remains devnet-only and exports no keys. No testnet/mainnet routing or implicit account import is added. |
| Status compatibility | Legacy core functionality is retained until a usable integrated TUI artifact is pinned and tested. The premature migration stub/example has been removed from this task's changes. |

The native plugin interface and ckb-cli read integration are feasible and implemented. Completing the original status migration is contingent on a released or explicitly maintained prebuilt ckb-cli artifact containing TUI; it must not be represented as completed by the v2.0.0 integration.

## Validation

```sh
pnpm test --runInBand
pnpm typecheck
pnpm lint
pnpm build
node scripts/plugin-binary-smoke.mjs
node scripts/plugin-binary-smoke.mjs --sandbox
# Optional public GitHub download and actual selected ckb-cli binary.
node scripts/plugin-binary-smoke.mjs --ckb-cli
# Optional real official platform archive; production checksum validation still applies.
node scripts/plugin-binary-smoke.mjs --ckb-cli-archive /path/to/official-platform-archive
node scripts/plugin-binary-smoke.mjs --sandbox --ckb-cli-archive /path/to/official-platform-archive
```

The synthetic production smoke uses a real native executable, isolated settings/storage, local RPC and (on POSIX, with Python 3) an actual PTY/raw-mode ioctl. The optional archive smoke checks the Rust binary's installation, help, read RPC, write-method denial and removal, not TUI or live-chain correctness. CI runs native trusted fixtures on Windows/macOS/Linux and sandbox fixtures on macOS/Linux. Local success on one platform is not evidence of success elsewhere.
