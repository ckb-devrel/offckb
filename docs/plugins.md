# Experimental local tool plugins

This is the first implementation stage of the [plugin proposal](plugin-system-proposal.md): explicit local registration, a versioned environment snapshot, and foreground process ownership. Registry downloads, `plugin add`, background plugins, `node --with`, and Fiber migration are deferred.

## Try the protocol

Build the CLI in this checkout, then explicitly link a local package you trust:

```sh
pnpm build
node build/index.js plugin link ./examples/plugins/context-probe
node build/index.js --json plugin list
node build/index.js --json context-probe -- --json "path with spaces" -- literal
node build/index.js context-probe --help
node build/index.js plugin unlink context-probe
```

The probe demonstrates exact argument forwarding and one JSON result. An uninitialized devnet is represented as `unknown`; the probe still works. Plugin code executes with your user permissions. Linking reads static metadata and never runs an install script or plugin module.

`link` stores a canonical package path. It does not copy or install dependencies. The package author/user prepares its runtime first. `unlink` removes the registration and keeps the package, data and cache. A foreground lease prevents concurrent runs of the same plugin and unlink/relink while it is running.

Registrations default to `<offckb data directory>/plugins`. `OFFCKB_PLUGIN_HOME` selects an isolated registry/data/cache directory, useful for development. It does not change core settings or select another devnet. Discovery probes `registry.json` even for core commands; an absent registry is not created. A broken registry does not block core commands or core help; `plugin list` reports the registry error without overwriting it. Invalid and incompatible packages remain removable. Future core command collisions are reported as `shadowed`, with the core command taking priority.

## Package declaration

```json
{
  "name": "my-offckb-tool",
  "version": "0.1.0",
  "engines": { "node": ">=20" },
  "offckb": {
    "apiVersion": 1,
    "command": "my-tool",
    "entry": "dist/cli.mjs",
    "description": "A local development tool"
  }
}
```

The entry must be a regular `.js`, `.cjs` or `.mjs` file whose real path stays inside the package. TypeScript compilation belongs to the package. Dependencies resolve from its own directory. The host launches the entry with its current Node executable, using argv arrays and inherited stdio/cwd; it does not import the tool into the ncc bundle.

Commands contain lowercase letters, digits and hyphens, starting with a letter (maximum 48 characters). Core names, `help`, and already-linked command names are reserved. Node engines and protocol version are checked before execution.

## Context and output

On execution, `OFFCKB_PLUGIN_CONTEXT` points to a temporary JSON file:

- `apiVersion: 1`, `offckbVersion`, `cwd`, and `output: "json" | "text"`.
- `cli.node` and `cli.entry`: the current Node/CLI paths, not a PATH lookup.
- `plugin.command`, `plugin.dataPath`, `plugin.cachePath`: persistent, plugin-specific storage.
- `devnet.rpcUrl`, `proxyUrl`, `kind`, `genesisHash`, `addressPrefix`, `systemScriptsFile`, `systemScriptsVersion: 1`.
- Optional `devnet.diagnostic: { code: "LIST_HASHES_FAILED", message: string }` when local metadata export fails. Consumers must tolerate additive fields in API version 1.

The scripts file contains a `devnet` record using the existing `system-scripts` entry shape. It and the context are removed after the child closes, including failures and handled signals. Data/cache remain. No account keys or complete settings object are copied. RPC URLs can contain credentials; plugins must avoid dumping the context or raw URLs to logs.

Chain metadata comes from the configured managed CKB binary's local `list-hashes` output, with a three-second limit and no shell interpolation. A missing config/binary yields `kind: "unknown"`, null chain identity and no scripts file. Timeout, nonzero exit or invalid output yields the same unknown identity plus the diagnostic above; raw subprocess errors/stderr are excluded. Chain-independent plugins can continue. Invalid core settings or inability to write the context still fails the invocation. A custom fork marker without a recognized public genesis also yields `unknown`. Plugins needing a known chain must reject these cases, and must verify the RPC genesis against the context before interpreting addresses/scripts. A custom `node --binary-path` with no matching managed binary is not yet supported by the context exporter.

Standalone `offckb my-tool --help` / `-h` is delegated without exporting context or reading core settings. Tools should handle that request before reading `OFFCKB_PLUGIN_CONTEXT`. With additional arguments, normal context preparation still runs; the host does not guess whether a help-looking token is an option value or literal plugin argument.

Core `--json` must precede the plugin command:

```sh
offckb --json my-tool --project .
offckb my-tool --json
offckb --json my-tool -- --json -- literal
```

The first invocation selects core JSON mode. In the second, `--json` is a plugin argument and core JSON mode stays off. The host consumes only an immediately following `--` separator; all remaining tokens, including another `--`, are preserved. Existing core commands retain their flag normalization.

After delegation, the child owns stdout, including its single JSON success result. The host never appends its fallback result; it propagates child exit status. Diagnostics and structured failures belong on stderr. This preserves the host's stream contract but does not validate or sandbox a misbehaving plugin's output.

## Explorer experiment

The example adapter uses `wildanrhmn/ckb-devnet-explorer` at commit `477af4400a716353d140fc1a5b8fee8175f74fed` (0.2.0), verified unchanged on 2026-10-29. It is **an unpublished, repository-only experiment**, using pinned private source imports. Formal upstream entry points and a release maintainer are still needed before distribution.

The [formal-distribution gate](plugin-system-proposal.md#explorer-正式分发门禁) requires either released upstream APIs covered by semver or exclusive use of its public CLI with a pinned version and contract tests. A formal plugin PR retaining source replacements, private imports, tsx export-map inspection or the **PROTOTYPE-ONLY** `OFFCKB_EXPLORER_SOURCE` override must not merge. A successful local experiment does not clear this gate.

Prepare a source checkout at that revision:

```sh
git clone https://github.com/wildanrhmn/ckb-devnet-explorer.git /tmp/ckb-devnet-explorer
git -C /tmp/ckb-devnet-explorer checkout 477af4400a716353d140fc1a5b8fee8175f74fed
node scripts/prepare-explorer-prototype.mjs /tmp/ckb-devnet-explorer
npm install --prefix .prototype/explorer --omit=dev --ignore-scripts

node build/index.js plugin link ./examples/plugins/explorer
node build/index.js node --daemon
node build/index.js explorer --project /path/to/deployed-project --port 7070
```

The preparation script copies source into ignored `.prototype/explorer`; it does not edit the checkout supplied by the user. The local copy adds an explicit server host and moves the upstream startup message to stderr. The adapter reads system scripts from the host snapshot, merges `deployment/scripts.json` from selected projects, and never invokes `offckb` from PATH. It loads tsx's declared ESM entry, matching upstream's ESM loader.

Node 22+ and an initialized ordinary devnet are required. Forks and unknown chain identities are rejected before listening. RPC genesis must match the supplied scripts context; missing/lagging built-in indexer is reported separately. The web server binds `127.0.0.1` and defaults to 7070; `--port 0` selects a free port. `--project` is repeatable and defaults to invocation cwd. There is no arbitrary `--rpc` override or automatic browser launch.

Ctrl+C stops the Explorer command, while a separately running CKB daemon continues. Restart Explorer after redeployment, chain reset or chain switching so its script names and caches reload. Upstream acceptance of new APIs is not required for this local experiment, but the experiment is not a promise to maintain a fork.

## Validation and remaining limits

```sh
pnpm test --runInBand
pnpm typecheck
pnpm lint
pnpm build
# Optional: prepared Explorer runtime and an official CKB 0.208.0 binary are required.
node scripts/plugin-smoke.mjs /path/to/ckb
```

The opt-in smoke test uses the production ncc bundle, random local ports, temporary settings and a copied devnet. It checks exact argv, single JSON result, offline help, continued probe execution after a real `list-hashes` failure, the real Explorer page/API, current RPC/project context, refusal to unlink a running plugin, signal cleanup, CKB remaining alive, chain reset/restart and rejection of an unknown fork marker. It redirects `os.homedir()` only inside its test workers before loading the bundle; it does not change HOME or user settings. Downloaded binaries, source and runtime dependencies are not shipped.

The second-tool paper review uses existing `src/cmd/status.ts`: ckb-tui would consume `proxyUrl`, retain TTY checks and forward native `-r`/optional `-t` arguments from a Node adapter. The current context lacks the optional TCP log address, so the minimal adapter could use RPC-only mode; adding that address or requiring full log panels needs a later explicit protocol decision. Native TTY/job-control behavior still requires testing. Existing `status` stays in core.

POSIX plugin processes use an invocation-owned group. SIGINT/SIGTERM/SIGHUP are forwarded; a three-second shutdown limit and final group cleanup prevent owned descendants from remaining after the tool exits. The host never signals a saved PID. Windows immediately uses `taskkill /T /F` without a graceful period. The signal test skips Windows; passing its ordinary spawn tests does not verify this branch. Native Windows interrupt, process-tree cleanup and exit-status validation remain open for Phase 1. Plugins must not detach their own unmanaged daemons.

SIGKILL, host crashes or power loss can leave `registry.lock`, `<command>.running`, or temporary context directories. This stage fails closed on those locks: verify the owner/tool has stopped before removing the named stale file, then retry. Automatic crash recovery, full runtime identity management, concurrent instances and background services are deferred. Registry locks are short-lived and registration writes use atomic rename; tool source itself remains mutable because this is explicit local linking.
