# @offckb/plugin-explorer

Unpublished adapter for the **public** ckb-devnet-explorer CLI integration API v1. This package is private until [the upstream interface contribution](https://github.com/wildanrhmn/ckb-devnet-explorer/pull/1) is merged and released. `0.3.0` is the proposed provider version, not a claim that npm already contains it.

Requires sandboxed offckb, macOS/Linux and Node 22.21+ (22.x) or 24.5+. Install the exact provider dependency with scripts disabled, then:

```sh
offckb plugin link /path/to/this/package \
  --allow devnet-read --allow project-deployment --allow serve
offckb --plugin-port 7070 explorer --project .
```

Only an initialized ordinary devnet is supported. Forks/unknown chain identity or a mismatching genesis are rejected. Indexer lag is reported separately. Restart after deploy/reset. Additional projects require explicit `--read /absolute/project/deployment` grants when linking.

The adapter invokes the provider's declared npm bin with `--integration-info`, then `serve --json --rpc <read gateway> --system-scripts <snapshot> --bridge <socket>`. It checks API v1 and the capabilities `system-scripts`, `host`, `bridge`, `json-ready`; one JSON ready record is required. No private imports, PATH invocation of offckb or source overrides are used. The host owns loopback serving and descendant cleanup.

See [the plugin guide](../../docs/plugins.md) for grants, context, security limits and validation. Do not publish this package or substitute an unrelated upstream version to bypass its compatibility check.

To reproduce pre-release integration tests, use the upstream PR commit as a normal npm provider tarball (not a source-import override):

```sh
git clone https://github.com/RetricSu/ckb-devnet-explorer.git .prototype/explorer-public-cli
git -C .prototype/explorer-public-cli checkout fecb659
npm pack ./.prototype/explorer-public-cli --ignore-scripts --pack-destination .prototype
npm install --prefix packages/plugin-explorer --no-save --package-lock=false \
  --omit=dev --ignore-scripts ./.prototype/ckb-devnet-explorer-0.3.0.tgz
pnpm build
node scripts/plugin-smoke.mjs /path/to/ckb-0.208.0
```

This validates the proposed contract locally; it does not satisfy the upstream release gate. Keep these test artifacts out of the published package.
