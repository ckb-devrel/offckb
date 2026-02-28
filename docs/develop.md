# Development Guide

This is the **single source of truth** for all development workflows in OffCKB.

## Table of Contents

- [Development Guide](#development-guide)
	- [Table of Contents](#table-of-contents)
	- [Local Development Setup](#local-development-setup)
		- [Prerequisites](#prerequisites)
		- [Clone \& Install](#clone--install)
		- [Run in Development Mode](#run-in-development-mode)
		- [Build for Production](#build-for-production)
	- [Common Commands](#common-commands)
	- [Code Architecture](#code-architecture)
	- [Branch Management](#branch-management)
	- [PR Workflow](#pr-workflow)
	- [Changesets (Changelog)](#changesets-changelog)
		- [When to create a changeset](#when-to-create-a-changeset)
		- [How to create a changeset](#how-to-create-a-changeset)
		- [Empty changesets](#empty-changesets)
		- [How changesets are consumed](#how-changesets-are-consumed)
	- [Release Process](#release-process)
		- [Standard Release (to npm `latest`)](#standard-release-to-npm-latest)
		- [Canary Release (to npm `canary`)](#canary-release-to-npm-canary)
	- [Testing](#testing)
		- [Conventions](#conventions)
		- [What to test](#what-to-test)
		- [Coverage](#coverage)
	- [Updating Built-in CKB Scripts](#updating-built-in-ckb-scripts)
	- [Updating Chain Config](#updating-chain-config)
	- [Updating Templates](#updating-templates)
	- [Updating CKB WASM Debugger](#updating-ckb-wasm-debugger)

---

## Local Development Setup

### Prerequisites

- Node.js >= 20.0.0
- pnpm (install via `npm install -g pnpm`)

### Clone & Install

```sh
git clone --recurse-submodules https://github.com/ckb-devrel/offckb.git
cd offckb
pnpm install
```

> If you already cloned without `--recurse-submodules`, run `git submodule update --init --recursive`.

### Run in Development Mode

```sh
pnpm start
# This runs ts-node-dev with hot-reload on src/cli.ts
```

### Build for Production

```sh
pnpm build
# tsc → ncc bundle → build/index.js
```

---

## Common Commands

| Command               | Description                                  |
|-----------------------|----------------------------------------------|
| `pnpm start`          | Run CLI in dev mode (ts-node-dev, hot-reload)|
| `pnpm build`          | Build production bundle to `build/`          |
| `pnpm lint`           | Run ESLint on `src/**/*.ts`                  |
| `pnpm lint:fix`       | Run ESLint with auto-fix                     |
| `pnpm fmt`            | Format code with Prettier                    |
| `pnpm typecheck`      | TypeScript type check (`tsc --noEmit`)       |
| `pnpm test`           | Run unit tests (Jest)                        |
| `pnpm test:watch`     | Run tests in watch mode                      |
| `pnpm test:coverage`  | Run tests with coverage report               |
| `pnpm test:ci`        | Run tests with coverage (CI mode)            |
| `pnpm changeset`      | Create a changeset file for your PR          |
| `pnpm clean`          | Remove `dist/`, `build/`, `target/`          |

---

## Code Architecture

**Key directories:**

| Directory | Role |
|-----------|------|
| `src/cli.ts` | Entry point — registers all CLI commands via `commander` |
| `src/cmd/` | Command implementations, one file per CLI command (e.g. `node.ts`, `create.ts`, `deploy.ts`) |
| `src/cfg/` | Configuration: accounts, environment paths, settings |
| `src/sdk/` | CKB SDK wrappers (RPC calls, network utilities) |
| `src/deploy/` | Contract deployment logic (migration, script handling, TOML generation) |
| `src/tools/` | WASM debugger, RPC proxy, transaction dumper |
| `src/tui/` | Terminal UI (blessed-based devnet config editor) |
| `src/templates/` | Project scaffolding template processing |
| `src/util/` | Shared utilities (fs, encoding, logger, validator, etc.) |
| `src/type/` | Shared TypeScript type definitions |
| `ckb/` | Git submodules for CKB smart contract source code, built via `Makefile` |
| `templates/v4/` | Project scaffolding templates shipped with the CLI |
| `build/` | ncc-bundled production output — **never edit directly** |

**Conventions:**
- Adding a new CLI command: create `src/cmd/<name>.ts`, register it in `src/cli.ts`
- `src/cmd/*` modules should use `src/sdk/` for CKB interaction and `src/util/` for helpers
- Keep `src/type/base.ts` for shared types; command-specific types stay in command files
- Native CKB script binaries live in `ckb/` submodules — modify via `Makefile`, not directly

---

## Branch Management

| Branch | Purpose | CI |
|--------|---------|----|
| `develop` | Development mainline. All feature/fix branches merge here first. Version is kept up-to-date with bumps. | lint + test (matrix) |
| `master` | Stable release branch. Receives merges from `develop` for formal releases. | lint + test + publish on tag |
| `feature/*` | New feature work. Branch from `develop`, merge back to `develop`. | lint + test |
| `fix/*` | Bug fixes. Branch from `develop`, merge back to `develop`. | lint + test |
| `v0.*.x` | Canary / maintenance branches. Pushes auto-publish canary releases to npm. | canary publish |

**Normal flow — all changes go through `develop` first:**
```
feature/* ──→ develop ──→ v0.*.x ──→ canary publish (npm canary tag)
                     └──→ master ──→ tag v*.*.* ──→ npm publish (latest)
```

**Exception — direct commits to `v0.*.x` (skip develop):**
Only for:
- Hotfix that needs immediate canary release
- Legacy/incompatible branches (e.g. v2, v3) that diverge from current `develop`

```
fix/* ──→ v0.*.x (direct) ──→ canary publish
```

---

## PR Workflow

1. Create a branch from `develop` (e.g. `feature/add-foo` or `fix/bar-crash`)
2. Make your changes
3. Run `pnpm changeset` to generate a changeset file describing the change (**required by CI**)
   - For changes that don't need a changelog entry (docs, CI config, pure refactoring), use `pnpm changeset --empty`
4. Commit and push. Pre-commit hooks will automatically run:
   - ESLint (with auto-fix) + Prettier on staged `.ts` files
   - Prettier on staged template/account files
   - TypeScript type check (`tsc --noEmit`)
5. Open a PR to `develop` (or `master` for hotfix)
6. CI must pass:
   - **Nodejs CI**: lint + build + format consistency check
   - **Test**: unit tests + integration tests (Ubuntu/Windows/macOS)
   - **Changeset Check**: verifies a changeset file is present
7. Get code review, then merge

---

## Changesets (Changelog)

We use [changesets](https://github.com/changesets/changesets) to manage changelog entries and version bumps.

### When to create a changeset

**Every PR** must include a changeset file. CI will block the PR otherwise.

### How to create a changeset

```sh
pnpm changeset
```

This interactive CLI will ask you:
1. **Version bump type**: `patch` (bug fix), `minor` (new feature), `major` (breaking change)
2. **Summary**: A human-readable description of the change (this goes into CHANGELOG.md)

The command creates a markdown file in `.changeset/` — commit it with your PR.

### Empty changesets

For PRs that don't affect the published package (documentation, CI, internal refactoring):

```sh
pnpm changeset --empty
```

This creates a changeset that satisfies CI but won't add a CHANGELOG entry or bump the version.

### How changesets are consumed

During the [release process](#release-process), `pnpm changeset version` reads all accumulated changeset files, determines the version bump, updates `package.json` version and `CHANGELOG.md`, then deletes the consumed changeset files.

---

## Release Process

### Standard Release (to npm `latest`)

1. Ensure `develop` is stable and all target PRs are merged
2. On `develop`, run changeset version to consume accumulated changesets:
   ```sh
   pnpm changeset version
   ```
   This consumes all `.changeset/*.md` files, updates `CHANGELOG.md` and bumps `package.json` version
3. Commit the version bump:
   ```sh
   git add .
   git commit -m "chore: release v$(node -p 'require(\"./package.json\").version')"
   ```
4. Merge `develop` into `master`
5. On `master`, create and push the tag:
   ```sh
   git tag v$(node -p 'require("./package.json").version')
   git push origin master --tags
   ```
6. The `Publish on Tag` workflow automatically publishes to npm

### Canary Release (to npm `canary`)

Merge `develop` into the target `v0.*.x` branch (or push directly for hotfix/legacy cases). The `Canary release on new commit` workflow will:
- Auto-bump version with a canary prerelease suffix (e.g. `0.4.5-canary-abc1234`)
- Publish to npm under the `canary` tag

> **Note:** Direct commits to `v0.*.x` (bypassing develop) should only be used for hotfixes or legacy branches that are incompatible with current `develop`.

---

## Testing

### Conventions

- Test files: `*.test.ts`
- Location: `tests/` directory (or `src/**/__tests__/` for co-located tests)
- Framework: Jest with ts-jest
- Run: `pnpm test`

### What to test

- **New features/fixes must include tests**
- Priority for coverage improvement:
  1. Pure logic modules: `src/util/`, `src/cfg/`, `src/scripts/`, `src/deploy/`
  2. Command logic: `src/cmd/*` (mock CKB node / file system as needed)
  3. Template processing: `src/templates/`
- Integration tests: `scripts/create-test.sh` (runs full create → build → test cycle)

### Coverage

- CI enforces a minimum coverage threshold (currently 10% statements)
- The threshold will be raised as tests are added
- View coverage locally: `pnpm test:coverage` then open `coverage/index.html`
- Coverage is uploaded to Codecov on CI (Ubuntu only)

---

## Updating Built-in CKB Scripts

**Prerequisites:**
- rust/cargo
- [capsule](https://github.com/nervosnetwork/capsule/releases)
- docker

Update the relevant submodule inside `ckb/`, then run:

```sh
make all
```

See `Makefile` for individual targets: `omnilock`, `anyone-can-pay`, `xudt`, `spore`, `ckb-js-vm`, `nostr-lock`, `pw-lock`, `secp256k1_multisig_v2`.

---

## Updating Chain Config

Edit files in `ckb/devnet/`.

All script configs are generated by `ckb list-hashes` — you don't need to manually maintain script hashes.

---

## Updating Templates

Edit files in `templates/v4/`. Template files use `.template` extension and are processed by `src/templates/processor.ts`.

---

## Updating CKB WASM Debugger

**Prerequisites:**
- rust/cargo
- wasm32-wasip1 target: `rustup target add wasm32-wasip1`
- On Linux: `sudo apt install gcc-multilib`

Update the `ckb-standalone-debugger` submodule, then run:

```sh
make ckb-debugger
```
