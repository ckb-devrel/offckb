# Sandboxed local tool plugins

Plugins are independent npm-shaped packages with a static declaration and a prebuilt JavaScript entry. The host supplies a versioned context and runs each tool in an OS sandbox. This stage implements explicit `link/list/unlink`, foreground execution and capability grants. Registry installation, background services and plugin dependencies are deferred.

## Try the protocol

Use macOS or Linux, Node **22.21+ (22.x) or 24.5+**, and a working sandbox backend. macOS uses `sandbox-exec`; Linux requires bubblewrap, socat, ripgrep and permitted unprivileged user namespaces. The runtime is an optional npm dependency so core Node 20 installations remain supported; plugin users must install it on a supported Node version without omitting optional dependencies. A missing runtime or backend failure stops execution. There is no unsandboxed fallback. Windows plugin execution is disabled until a suitable backend is validated. Core offckb commands still support Node 20 on all three platforms.

```sh
pnpm build
node build/index.js plugin link ./examples/plugins/context-probe
node build/index.js --json plugin list
node build/index.js --json context-probe -- --json "path with spaces" -- literal
node build/index.js context-probe --help
node build/index.js plugin unlink context-probe
```

Linking reads metadata; it does not execute the plugin, install dependencies or run install scripts. `link` records the canonical package directory and explicit grants. `unlink` keeps the package and its data/cache. A lease prevents concurrent execution or relinking/unlinking a running tool.

A third party can publish a normal npm package. Until an installer exists, prepare it in a dedicated directory with an exact dependency version, `npm install --save-exact --omit=dev --ignore-scripts <package>@<version>`, inspect it, then link its directory under `node_modules`. Dependencies must work without installation scripts. Installing with an external package manager is outside the runtime sandbox; never enable unreviewed lifecycle scripts on the assumption that offckb will contain them.

Registrations default to `<offckb data directory>/plugins`. `OFFCKB_PLUGIN_HOME` selects isolated registry/storage; it does not change core settings. Discovery probes `registry.json` even for core commands, without creating an absent registry. Broken declarations/registries do not block core commands. `plugin list` reports invalid/incompatible entries; future core collisions are `shadowed` and remain removable. Legacy registrations have zero capability grants; new permissions require relinking.

## Declaration and grants

```json
{
  "name": "my-offckb-tool",
  "version": "0.1.0",
  "engines": { "node": "^22.21.0 || >=24.5.0" },
  "offckb": {
    "apiVersion": 1,
    "command": "my-tool",
    "entry": "dist/cli.mjs",
    "description": "A local development tool",
    "permissions": ["devnet-read", "project-deployment", "serve"]
  }
}
```

The entry must be a regular `.js`, `.cjs` or `.mjs` file whose real path stays inside the package. Commands start with a lowercase letter and contain lowercase letters, digits or hyphens, at most 48 characters. Core and duplicate names are reserved. Protocol and Node engine compatibility are checked before execution.

Every requested capability must be explicitly granted:

```sh
offckb plugin link /path/to/package \
  --allow devnet-read --allow project-deployment --allow serve
# Additional files or directories must be granted individually:
offckb plugin link /path/to/package --allow devnet-read --read /path/to/report.json
```

| Grant | Access |
| --- | --- |
| None | Read package/runtime dependencies and invocation context; write own data/cache and temporary directory |
| `devnet-read` | Reach only a host-owned JSON-RPC gateway with an explicit read-method allowlist; no transaction submission or node administration |
| `project-deployment` | Read the invocation project's `deployment/` directory; an escaping directory symlink is rejected |
| `serve` | Serve HTTP over a designated Unix socket to a host-owned `127.0.0.1` listener; no arbitrary TCP bind or loopback access |
| `--read <path>` | Read the canonical file/directory, recursively for directories; treat this as disclosure of its contents |

Capabilities do not grant arbitrary Internet access, project writes, access to other plugins' data, SSH agents, keys or core settings. Manifest changes that add capabilities invalidate the registration until explicitly relinked. Local package source remains mutable; review changes before running it again.

The host uses the pinned [Anthropic sandbox runtime](https://github.com/anthropics/sandbox-runtime) as an external npm dependency. OS restrictions apply to descendants too. Caller environment variables are replaced with a small allowlist: no inherited tokens, proxy credentials, SSH agent socket, Node preload options or module search overrides. The sandbox can read required OS/runtime locations and its package/dependency tree, so keep credentials out of these locations and out of packages. This is a filesystem/network boundary, not a VM or a resource quota: CPU/memory exhaustion, terminal output and OS/runtime vulnerabilities remain risks. Trust and review plugin code, particularly before granting additional read paths.

## Context and output

`OFFCKB_PLUGIN_CONTEXT` points to a temporary JSON file containing:

- `apiVersion: 1`, `offckbVersion`, invocation `cwd`, and `output: "json" | "text"`.
- `cli.node` and `cli.entry`: informative paths; they do not grant access to core files or permission to run privileged core operations.
- `plugin.command`, `plugin.dataPath`, `plugin.cachePath`: plugin-specific persistent storage.
- `devnet.kind`, `genesisHash`, `addressPrefix`, `systemScriptsFile`, `systemScriptsVersion: 1`.
- `devnet.rpcUrl` and `proxyUrl`: empty without `devnet-read`; otherwise the restricted gateway URL. Original RPC URLs, userinfo and credentials stay in the host.
- `sandbox.backend: "os"`, granted `permissions`, and optional `http: { socket, url }` for `serve`.
- Optional `devnet.diagnostic: { code: "LIST_HASHES_FAILED", message: string }`. Consumers must tolerate additive API v1 fields.

The process working directory is the package directory. Resolve project-relative arguments against **context.cwd**; that path alone grants no filesystem access. Only the listed paths/capabilities are available. The system scripts file uses the existing `devnet` record shape. Context/scripts and sandbox scratch storage are removed on normal/handled exit; data/cache remain. No account keys or full settings are exported.

Chain metadata uses the managed CKB binary's local `list-hashes`, with a three-second timeout. Missing or failed metadata yields `unknown`, null identity/scripts and, on failure, a safe diagnostic; chain-independent tools can continue. Invalid settings/context writes still fail. Custom binaries without matching managed metadata remain unsupported. Chain-aware tools must reject unknown/unsupported chains and verify RPC genesis before interpreting addresses/scripts.

Standalone `--help`/`-h` is sandboxed but skips settings and context export. Handle it before reading the context. Help mixed with other arguments follows normal preparation.

Core flags must precede the plugin name:

```sh
offckb --json --plugin-port 7070 my-tool --project .
offckb my-tool --json
offckb --json my-tool -- --json -- literal
```

In the second invocation `--json` belongs to the plugin. The host consumes only the immediately following `--` separator and preserves the rest. `--plugin-port` selects the host HTTP listener (default 7070, `0` selects a free port); only `serve` uses it. The plugin owns stdout after delegation, including its one JSON result. Diagnostics go to stderr; the parent propagates exit status without appending a fallback result. A malicious plugin can still violate this output convention.

The RPC gateway only accepts bounded JSON-RPC 2.0 POST requests with array params and known read methods. Redirects, batches, write/admin methods and oversized requests/responses are rejected. Browser-facing HTTP responses receive host-controlled CSP, no-referrer and nosniff headers; the bridge provides no CONNECT or WebSocket tunnel. It cannot protect information the user explicitly enters into a plugin UI or eliminate every browser-side risk.

## Explorer through a public upstream CLI

The adapter is now [packages/plugin-explorer](../packages/plugin-explorer). It exclusively resolves upstream's declared npm `bin` and invokes its public CLI; it does not import private `src/*.ts`, inspect tsx exports, replace source strings, or accept a source-path override. The former private-source prototype and preparation script have been removed.

The adapter requires a pinned upstream release with integration API v1: offline `--integration-info`, `--system-scripts`, explicit `--host`, outbound Unix `--bridge` transport, and a single versioned JSON ready record. Its provisional dependency is `ckb-devnet-explorer@0.3.0`. **That upstream release is not yet available ([upstream PR #1](https://github.com/wildanrhmn/ckb-devnet-explorer/pull/1)); the adapter package is private and must not be published until the upstream contract is merged/released and the exact version is confirmed.** Local tests use an npm tarball of the upstream contribution, never a private import fallback. See the [distribution gate](plugin-system-proposal.md#explorer-正式分发门禁).

Once the released provider is available:

```sh
npm install --prefix packages/plugin-explorer --omit=dev --ignore-scripts
node build/index.js plugin link ./packages/plugin-explorer \
  --allow devnet-read --allow project-deployment --allow serve
node build/index.js node --daemon
node build/index.js --plugin-port 7070 explorer --project .
# Other project deployment directories require explicit --read grants at link time; use canonical absolute paths for --project (symlink aliases outside the granted tree are unavailable).
```

Only ordinary devnet with `ckt` is supported. Unknown chains/forks fail before ready. RPC genesis must match context; missing/lagging indexer is reported separately. The adapter receives only read RPC access; the host exposes the page on loopback. Ctrl+C stops the tool without stopping a separately running CKB node. Restart after redeploy, reset or chain switching to reload scripts/caches. There is no arbitrary RPC override or automatic browser launch.

## Validation and limits

```sh
pnpm test --runInBand
pnpm typecheck
pnpm lint
pnpm build
node scripts/plugin-sandbox-smoke.mjs
# Optional: public provider installed and official CKB 0.208.0 binary:
node scripts/plugin-smoke.mjs /path/to/ckb
```

The native security test exercises the production bundle with canary secrets: forbidden reads/writes, symlink/child escape, direct network access, credential inheritance and write RPC rejection, plus positive cache/read-RPC access. CI runs it on native macOS/Linux with Node 24. The live test additionally checks Explorer page/API, ready output, SIGTERM, node survival, chain reset/restart and unknown-fork rejection. Tests isolate settings and override `os.homedir()` only in their worker, without changing HOME.

POSIX foreground groups receive SIGINT/SIGTERM/SIGHUP, a three-second limit and final owned-process cleanup. No saved PID is signalled. Windows plugin execution is refused. Crash/SIGKILL can leave registry/run locks or temporary files: confirm the tool has stopped before manual cleanup. Automatic crash recovery, concurrent instances, resource quotas, background services and arbitrary network grants are deferred. A second-tool `ckb-tui` adapter still needs native TTY and sandbox network adaptation; its existing core `status` command is unchanged.
