# Local tool plugins

Plugins are independent npm-shaped packages with a static declaration and a prebuilt JavaScript entry. The host supplies a versioned context and runs each tool in a separate process. Execution uses an OS sandbox by default; users may explicitly trust an individual package for native execution. This stage implements `link/list/unlink`, foreground execution and capability grants. Registry installation, background services and plugin dependencies are deferred.

## Platform boundary

| Mode | Platforms | Requirements |
| --- | --- | --- |
| `sandbox` (default) | macOS/Linux | Node 22.21+ (22.x) or 24.5+, sandbox-runtime and OS prerequisites below |
| `trusted` (explicit `--trust`) | Windows/macOS/Linux | Node 20+, or the plugin's own higher engine requirement; no sandbox runtime, WSL or administrator setup required |

Windows core commands work without WSL. Windows users can run plugins natively after explicitly selecting trusted mode when linking:

```sh
offckb plugin link /path/to/package --trust --allow devnet-read
offckb plugin list
offckb my-tool
```

`--trust` authorizes execution with the current user's OS permissions, without file or network isolation. A plugin can read/modify files, access other plugins' data, start processes and use the network wherever that user can. The host filters inherited environment variables and supplies a minimal context/read-RPC gateway, but these measures cannot stop trusted code from obtaining information or accessing services independently. Capabilities describe host-provided interfaces in this mode; `--read` is not an access ceiling. Run only code you trust, including its dependencies. The runner does not request elevation; starting offckb elevated also elevates a trusted child.

The trust record is local to the canonical package directory and its name/version. A name/version change or newly requested capability requires relinking with the appropriate grants. Local source and dependencies remain mutable: this is not a signature, content hash or protection against modifications that retain the same version. `plugin list` and JSON link/list results show `trusted` or `sandbox`. A package cannot select trusted execution in its own manifest. Relink without `--trust` to return to sandbox mode; existing registrations stay sandboxed. A missing/failed sandbox never automatically enables trusted mode.

Native Windows OS sandboxing is not implemented. The pinned sandbox-runtime's Windows alpha requires machine-wide setup and has [documented network-fence limitations](https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#known-limitations); this host does not install or use it. WSL2 sandbox execution remains unvalidated, rather than a prerequisite for native Windows plugins.

## Try the protocol

For default sandbox mode, use macOS or Linux, Node **22.21+ (22.x) or 24.5+**, and a working sandbox backend. macOS uses `sandbox-exec`; Linux requires bubblewrap, socat, ripgrep and permitted unprivileged user namespaces. The runtime is an optional npm dependency; sandbox users must install it without omitting optional dependencies. Missing dependencies stop sandbox execution. Core commands and explicitly trusted plugins support Node 20 on all three platforms without this dependency.

```sh
pnpm build
node build/index.js plugin link ./examples/plugins/context-probe
node build/index.js --json plugin list
node build/index.js --json context-probe -- --json "path with spaces" -- literal
node build/index.js context-probe --help
node build/index.js plugin unlink context-probe
```

On native Windows, add `--trust` to the link command above. No trust prompt is repeated on each run; link records the explicit choice.

Linking reads metadata; it does not execute the plugin, install dependencies or run install scripts. `link` records the canonical package directory and explicit grants. `unlink` keeps the package and its data/cache. A lease prevents concurrent execution or relinking/unlinking a running tool.

A third party can publish a normal npm package. Until an installer exists, prepare it in a dedicated directory with an exact dependency version, `npm install --save-exact --omit=dev --ignore-scripts <package>@<version>`, inspect it, then link its directory under `node_modules`. Dependencies must work without installation scripts. Installing with an external package manager is outside the runtime sandbox; never enable unreviewed lifecycle scripts on the assumption that offckb will contain them.

Registrations default to `<offckb data directory>/plugins`. `OFFCKB_PLUGIN_HOME` selects isolated registry/storage; it does not change core settings. Discovery probes `registry.json` even for core commands, without creating an absent registry. Broken declarations/registries do not block core commands. `plugin list` reports invalid/incompatible entries; future core collisions are `shadowed` and remain removable. Legacy registrations have zero capability grants; new permissions require relinking.

## Declaration and grants

```json
{
  "name": "my-offckb-tool",
  "version": "0.1.0",
  "engines": { "node": ">=20" },
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
| None | In sandbox mode, read package/runtime dependencies and invocation context; write back to host only through own data/cache and temporary directory |
| `devnet-read` | Reach only a host-owned JSON-RPC gateway with an explicit read-method allowlist; no transaction submission or node administration |
| `project-deployment` | Read the invocation project's `deployment/` directory; an escaping directory symlink is rejected |
| `serve` | Serve HTTP over an authenticated reverse connection to a host-owned `127.0.0.1` listener; sandbox mode adds no arbitrary TCP bind or loopback access |
| `--read <path>` | Read the canonical file/directory, recursively for directories; treat this as disclosure of its contents |

In sandbox mode, capabilities do not grant arbitrary Internet access, project writes, access to other plugins' data, SSH agents, keys or core settings. Trusted mode has the user's OS access regardless of these grants. In both modes, manifest changes that add capabilities invalidate the registration until explicitly relinked. Review package/dependency changes before running them again.

For sandbox mode, the host uses the pinned [Anthropic sandbox runtime](https://github.com/anthropics/sandbox-runtime) as an external npm dependency. OS restrictions apply to descendants too. Linux may accept writes into private tmpfs views of hidden paths; these do not modify the corresponding host files. Native tests verify a pre-existing host canary remains unchanged, independently of the plugin's reported syscall result. Caller environment variables are replaced with a small allowlist: no inherited tokens, proxy credentials, SSH agent socket, Node preload options or module search overrides. The sandbox can read required OS/runtime locations and its package/dependency tree, so keep credentials out of these locations and out of packages. This is a filesystem/network boundary, not a VM or a resource quota: CPU/memory exhaustion, terminal output and OS/runtime vulnerabilities remain risks. Trust and review plugin code, particularly before granting additional read paths.

## Context and output

`OFFCKB_PLUGIN_CONTEXT` points to a temporary JSON file containing:

- `apiVersion: 1`, `offckbVersion`, invocation `cwd`, and `output: "json" | "text"`.
- `cli.node` and `cli.entry`: informative paths; they do not grant access to core files or permission to run privileged core operations.
- `plugin.command`, `plugin.dataPath`, `plugin.cachePath`: plugin-specific persistent storage.
- `devnet.kind`, `genesisHash`, `addressPrefix`, `systemScriptsFile`, `systemScriptsVersion: 1`.
- `devnet.rpcUrl` and `proxyUrl`: empty without `devnet-read`; otherwise the restricted gateway URL. Original RPC URLs, userinfo and credentials stay in the host.
- `sandbox.backend: "os" | "none"` (`none` means trusted execution without OS isolation), granted host-interface `permissions`, and optional `http: { transport: "proxy-connect-v1" | "tcp-v1", endpoint, token, url }` for `serve`.
- Optional `devnet.diagnostic: { code: "LIST_HASHES_FAILED", message: string }`. Consumers must tolerate additive API v1 fields.

The process working directory is the package directory. Resolve project-relative arguments against **context.cwd**; that path alone grants no filesystem access. In sandbox mode only the listed paths/capabilities are available; trusted mode retains the user's OS permissions. The system scripts file uses the existing `devnet` record shape. Context/scripts and sandbox scratch storage are removed on normal/handled exit; data/cache remain. No account keys or full settings are exported.

Chain metadata uses the managed CKB binary's local `list-hashes`, with a three-second timeout. Missing or failed metadata yields `unknown`, null identity/scripts and, on failure, a safe diagnostic; chain-independent tools can continue. Invalid settings/context writes still fail. Custom binaries without matching managed metadata remain unsupported. Chain-aware tools must reject unknown/unsupported chains and verify RPC genesis before interpreting addresses/scripts.

Standalone `--help`/`-h` uses the registered execution mode but skips settings and context export. Handle it before reading the context. Help mixed with other arguments follows normal preparation.

Core flags must precede the plugin name:

```sh
offckb --json --plugin-port 7070 my-tool --project .
offckb my-tool --json
offckb --json my-tool -- --json -- literal
```

In the second invocation `--json` belongs to the plugin. The host consumes only the immediately following `--` separator and preserves the rest. `--plugin-port` selects the host HTTP listener (default 7070, `0` selects a free port); only `serve` uses it. The plugin owns stdout after delegation, including its one JSON result. Diagnostics go to stderr; the parent propagates exit status without appending a fallback result. A malicious plugin can still violate this output convention.

The RPC gateway only accepts bounded JSON-RPC 2.0 POST requests with array params and known read methods. Redirects, empty/over-200-call or mixed-permission batches, write/admin methods and oversized requests/responses are rejected. Browser-facing HTTP responses receive host-controlled CSP, no-referrer and nosniff headers; the bridge provides no CONNECT or WebSocket tunnel. It cannot protect information the user explicitly enters into a plugin UI or eliminate every browser-side risk.

## HTTP serving transport

For `serve`, `sandbox.http.url` is the public loopback URL. `endpoint` is a separate host-owned relay, and `token` authenticates this invocation. Keep the token private; it is not a browser URL or a persisted permission.

1. For `proxy-connect-v1` (sandbox mode), read the sandbox-injected `HTTP_PROXY`/`http_proxy` and open an HTTP CONNECT to `endpoint` through that proxy, including its proxy credentials. Only this relay destination is allowed by the `serve` grant. For `tcp-v1` (trusted mode), open a TCP connection directly to `endpoint`; no proxy is injected or required.
2. After the proxy returns 200 (or the direct TCP connection opens), send the UTF-8 line `offckb-http/1 <token>\n`. The host rejects a wrong/missing token and limits handshake size/time.
3. Wait for `OK\n`, then serve ordinary HTTP/1.1 requests on the established connection, in the reverse direction. Handle partial frames and preserve any bytes following the acknowledgement. Maintain several connections and reconnect closed ones; the host uses one request per connection with `Connection: close`.
4. Attach the HTTP handler before announcing readiness. The plugin chooses its own output record; the host never parses application logs.

In sandbox mode both macOS and Linux keep Unix-socket creation/access blocked; no arbitrary bind or direct loopback permission is added. Trusted mode does not restrict these OS operations. In both modes the public listener rejects CONNECT/Upgrade requests, and the internal relay accepts only authenticated reverse channels and never dials a plugin-selected destination. Synthetic fixtures demonstrate both transports without an application dependency: [sandbox](../scripts/plugin-sandbox-smoke.mjs), [trusted](../scripts/plugin-trusted-smoke.mjs).

## Third-party adapters

Each adapter is maintained and released independently by its author. The host has no built-in package list, preferred plugin, upstream-version pin or application-specific readiness logic. No particular adapter's upstream merge or npm release gates delivery of this generic plugin host.

Adapters consume the declared context/capabilities and keep their application's CLI flags, supported chains, version checks, readiness/output translation and dependencies in their own package. Use a dependency's public, versioned interfaces and maintain its integration tests in the adapter repository. offckb tests the host with synthetic fixtures, without installing or starting any third-party application.

## Validation and limits

```sh
pnpm test --runInBand
pnpm typecheck
pnpm lint
pnpm build
node scripts/plugin-sandbox-smoke.mjs
node scripts/plugin-trusted-smoke.mjs
```

The native security test exercises the production bundle with canary secrets: forbidden reads/writes, symlink/child escape, direct network access, credential inheritance and write RPC rejection, plus positive cache/read-RPC access. CI runs it on native macOS/Linux with Node 24. Synthetic fixtures also verify argv/JSON ownership, offline help, sandboxed HTTP serving, foreground shutdown and cleanup. Tests isolate settings and override `os.homedir()` only in their worker, without changing HOME.

Trusted-mode production smoke runs in the existing native Windows/macOS/Linux Node 20 CI matrix with sandbox-runtime resolution deliberately blocked. It verifies explicit trust, safe environment/context, read-only RPC, TCP HTTP serving, argv/JSON, help and interrupt cleanup. This checks the trusted contract, not OS isolation.

POSIX foreground groups receive SIGINT/SIGTERM/SIGHUP, a three-second limit and final owned-process cleanup. Windows shutdown uses `taskkill /T /F` for the live child tree, without a graceful signal period; exited/stored PIDs are never targeted. This is best-effort cleanup, not Job Object containment: deliberately detached children or a forcibly killed host can outlive it. Crash/SIGKILL can leave registry/run locks or temporary files: confirm the tool has stopped before manual cleanup. Automatic crash recovery, concurrent instances, resource quotas, background services and arbitrary sandbox network grants are deferred. A second-tool `ckb-tui` adapter still needs native TTY and sandbox network adaptation; its existing core `status` command is unchanged.

The pinned sandbox runtime still depends on Zod 3, covered by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (collection-validation memory exhaustion). In this integration Zod validates only host-generated policy before plugin startup, not network payloads or plugin-supplied schemas; this limits the exposed path but does not make the dependency patched. Do not expose runtime settings parsing as an untrusted API. Track an upstream-compatible fix rather than forcing Zod 4 across its declared API. Resource exhaustion remains outside the sandbox guarantee.
