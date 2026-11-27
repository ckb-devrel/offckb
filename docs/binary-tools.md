# Native binary tool plugins

Binary tools are native executables managed by offckb: installed into a stable host-owned path,
exposed through PATH shims and `OFFCKB_TOOL_*` environment variables, so third-party tools can
spawn them directly. They share the plugin registry and install/remove/list lifecycle with
JavaScript plugins, but there is no context/sandbox protocol — **binary tools always run natively
with your user permissions**.

## Where binaries come from

| Source | Command | Trust |
| --- | --- | --- |
| Official catalog (pinned per offckb release) | `offckb plugin install ckb-debugger` / `ckb-cli` | Implicit: the descriptor (URLs, versions, SHA-256s) is reviewed and shipped with offckb. Installing is trusting offckb's release process. |
| Local directory you point at | `offckb plugin install ./dir` | Your own decision, like running any local executable. |

The `Binary tools` section of `offckb plugin list` shows registered tools and catalog entries.
A catalog tool is marked `blocked` when a JavaScript plugin already uses its command name.
Use `offckb --json plugin list` for full source details.
`@latest` installs the catalog's pinned version; other versions fail closed with the pinned
version in the message — newer upstream releases arrive with offckb updates (a version-bump PR,
like every other pin in this repository). Request additional tools by issue or PR; there is no
author-side adaptation requirement and no third-party distribution channel.

A local binary directory contains an `offckb-tool.json` and the executable it declares:

```
my-tool/
  offckb-tool.json
  bin/my-tool          # POSIX: executable bit required; Windows: .exe
```

```sh
offckb plugin install ./my-tool
offckb my-tool --help
offckb plugin remove my-tool
```

The installer validates the declaration and the entry (a regular file inside the directory; no
escaping symlinks), then **copies** the declared executable into a managed directory — your
directory is never moved or modified. Reinstalling recopies, which is the intended author loop:
rebuild, `install ./dir`, test. Declared `permissions` still require explicit `--allow` flags.
`plugin link` is the JavaScript development flow and rejects binary directories with a pointer to
`install`.

## Using an installed binary

```sh
offckb ckb-debugger -- --version      # human passthrough: spawn the managed binary
offckb plugin which ckb-debugger      # stable path (--json for machines)
offckb plugin env                     # OFFCKB_TOOL_*=path lines; eval "$(offckb plugin env)"
```

`plugin remove` deletes the managed copy and the offckb-owned PATH shim (foreign files at the shim
location are never touched) and keeps data/cache. Upgrades are atomic replacements at the same
stable path; on Windows a running binary blocks the swap before the registry changes, leaving the
previous version fully usable.

## Descriptor v1 (maintainer format)

Catalog entries and local directories share one data format. This section documents the format
for maintainers writing catalog entries in `tools/`; end users only ever type install commands.

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
      "sha256": "64 lowercase hex digits",
      "format": "tar.gz",
      "executable": "my-tool-v1.2.3/my-tool"
    }
  }
}
```

- `name`: stable package identity, optionally scoped; owns storage across versions.
- `version`: exact semver. Catalog entries pin it; local directories record it as installed.
- `command`: what users type and what other tools spawn; core-command conflicts are rejected.
- `entry`: the executable, relative to the package root. Managed installs rewrite it to the
  managed binary name; local directories must have it executable (`.exe` on Windows).
- `permissions`: existing `devnet-read`, `project-deployment`, `serve` grants; every declared
  permission needs an explicit `--allow`.
- `execution`: optional fixed argv prefix and env bindings. Substitutions are limited to
  `${devnet.rpcUrl}` (requires `devnet-read`), `${plugin.dataPath}`, `${plugin.cachePath}`,
  `${cwd}`. There is no shell.
- `platforms`: required for catalog entries (downloads), optional for local directories.
  Keys are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`.
  Each asset pins an exact HTTPS URL, SHA-256, `format` (`raw`, `zip`, `tar.gz`) and the exact
  archive member to extract. Missing platform means a clean "no binary for this platform" error.

Catalog files may additionally carry `minVersion` (the adoption gate for pre-plugin legacy
installs) and `legacyInstallDir` (a leftover pre-plugin install is adopted instead of downloaded,
once, fully offline). To add a catalog tool: add `tools/<command>.json` and one line in
`src/plugins/catalog.ts`.

## ckb-cli

[tools/ckb-cli.json](../tools/ckb-cli.json) pins the official v2.0.0 release archives. Bindings
supply the read-only devnet gateway through `--url` and independent persistent storage through
`CKB_CLI_HOME`; existing accounts and keys are not imported.

```sh
offckb plugin install ckb-cli --allow devnet-read
offckb ckb-cli --help
offckb ckb-cli --local-only rpc get_tip_block_number
```

`--local-only` skips ckb-cli startup alert/network probes; explicitly requested RPCs still use
the gateway. Installing the complete executable does not grant write/admin RPCs, project writes,
signing integration or public-network routing. The integrated `ckb-cli tui` awaits a pinned
ckb-cli release that contains it; core `offckb status` remains operational until then.

## Validation

```sh
pnpm test --runInBand
pnpm typecheck
pnpm lint
pnpm build
node scripts/plugin-binary-smoke.mjs
# Optional real download of the pinned ckb-cli archive against a local RPC fixture:
node scripts/plugin-binary-smoke.mjs --ckb-cli
```

The synthetic production smoke uses a fixture binary, isolated settings/storage, a local RPC and
(on POSIX, with Python 3) a real PTY/raw-mode ioctl. The optional `--ckb-cli` run additionally
downloads the real pinned archive and exercises install/help/read RPC/write denial/removal.
Local success on one platform is not evidence of success elsewhere.
