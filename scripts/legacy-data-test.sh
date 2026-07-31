#!/bin/bash
#
# legacy-data-test.sh — upgrade-path regression test.
#
# Simulates a real user upgrading offckb: an OLD offckb release (with its old
# default CKB binary) creates a devnet from scratch; then the CURRENT build
# must operate on that legacy data without breaking it:
#
#   1. The chain CONTINUES — same genesis hash, tip grows past the old tip.
#      (A silent chain reset would still pass a bare "RPC responds" check.)
#   2. The legacy ckb.toml is migrated for new features — today that means the
#      Terminal RPC module and an enabled tcp_listen_address (required by
#      `offckb status` / ckb-tui). This is the exact class of bug that
#      historically reached users before we noticed.
#   3. The bundled chain spec (specs/dev.toml) is left byte-identical —
#      initChainIfNeeded must never overwrite an existing devnet config.
#   4. A fresh transfer on the upgraded chain succeeds and is committed.
#
# Everything runs inside a sandboxed HOME/XDG directory, so the test never
# touches the developer's real offckb data. CI runs this on ubuntu only.
#
# CONVENTION: when you add a feature that changes how offckb writes or
# migrates devnet config/data, extend the assertions here so the upgrade
# path for existing users keeps being covered.
#
# Requires: node, npm, pnpm, curl. Expects `pnpm build` to have run.

set -euo pipefail

OLD_OFFCKB_VERSION="${OLD_OFFCKB_VERSION:-0.3.4}" # ships CKB 0.113.1 as its default
KEEP_SANDBOX="${KEEP_SANDBOX:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_PORT=8114       # CKB devnet RPC (direct)
PROXY_PORT=28114    # offckb RPC proxy (new versions start it with `offckb node`)

OLD_PID=""
NEW_PID=""

log()  { echo "[legacy-test] $*"; }
fail() {
  echo "✗ $*" >&2
  for f in "$SANDBOX/old-node.log" "$SANDBOX/new-node.log"; do
    if [ -f "$f" ]; then
      echo "----- tail of $f -----" >&2
      tail -n 30 "$f" >&2 || true
    fi
  done
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# rpc <port> <method> <params-json> → response body (fails on curl error)
rpc() {
  curl -s -f -X POST -H 'content-type: application/json' \
    -d "{\"id\":2,\"jsonrpc\":\"2.0\",\"method\":\"$2\",\"params\":$3}" \
    "http://127.0.0.1:$1"
}

rpc_result() { # rpc_result <port> <method> <params-json> → .result as raw string
  rpc "$1" "$2" "$3" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'
}

wait_for_rpc() { # wait_for_rpc <port> <timeout-sec> [pid-to-watch]
  local port=$1 timeout=$2 pid=${3:-} i
  for ((i = 0; i < timeout; i++)); do
    if rpc "$port" get_tip_block_number '[]' >/dev/null 2>&1; then return 0; fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    sleep 1
  done
  return 1
}

tip_number() { # tip_number <port> → decimal tip
  local hex
  hex="$(rpc_result "$1" get_tip_block_number '[]')"
  [ -n "$hex" ] || return 1
  echo $((16#${hex#0x}))
}

wait_for_tip_at_least() { # wait_for_tip_at_least <port> <n> <timeout-sec> [pid-to-watch]
  local port=$1 want=$2 timeout=$3 pid=${4:-} i tip
  for ((i = 0; i < timeout; i++)); do
    tip="$(tip_number "$port" 2>/dev/null || echo 0)"
    if [ "$tip" -ge "$want" ]; then return 0; fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    sleep 2
  done
  return 1
}

wait_for_port_closed() { # wait_for_port_closed <port> <timeout-sec>
  local port=$1 timeout=$2 i
  for ((i = 0; i < timeout; i++)); do
    if ! rpc "$port" get_tip_block_number '[]' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Every process this test spawns — CLI, ckb run, ckb miner — carries the
# sandbox path in its argv (script path, -C config path, or binary path),
# so pattern-killing on $SANDBOX tears the whole tree down deterministically.
kill_sandbox_processes() {
  pkill -TERM -f "$SANDBOX" 2>/dev/null || true
}

stop_phase() { # stop_phase <pid-var-value>
  local pid=$1 i
  kill_sandbox_processes
  [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  for ((i = 0; i < 15; i++)); do
    if ! pgrep -f "$SANDBOX" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  pkill -KILL -f "$SANDBOX" 2>/dev/null || true
}

cleanup() {
  set +e
  kill_sandbox_processes
  if [ "$KEEP_SANDBOX" = "1" ]; then
    log "sandbox preserved at: $SANDBOX"
  else
    sleep 1
    rm -rf "$SANDBOX"
  fi
}

# --- Preconditions -----------------------------------------------------------

if [ ! -f "$REPO_ROOT/build/index.js" ]; then
  echo "✗ Local build not found at $REPO_ROOT/build/index.js — run 'pnpm build' first" >&2
  exit 1
fi
if rpc $RPC_PORT get_tip_block_number '[]' >/dev/null 2>&1 || \
   rpc $PROXY_PORT get_tip_block_number '[]' >/dev/null 2>&1; then
  echo "✗ Something is already listening on port $RPC_PORT/$PROXY_PORT — stop the running node first" >&2
  exit 1
fi

# Remember the real data home before sandboxing, to seed the current CKB
# binary below (saves a re-download when a node already ran on this machine).
REAL_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
# npm installs run against the user's real npm cache (content-addressed, safe
# to share) so CI can cache it and re-runs stay fast; everything else offckb
# touches stays inside the sandbox.
NPM_CACHE_DIR="${npm_config_cache:-$HOME/.npm}"

SANDBOX="$(mktemp -d /tmp/offckb-legacy-test.XXXXXX)"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export HOME="$SANDBOX/home"
export XDG_DATA_HOME="$SANDBOX/xdg-data"
export XDG_CONFIG_HOME="$SANDBOX/xdg-config"
export XDG_CACHE_HOME="$SANDBOX/xdg-cache"
export XDG_STATE_HOME="$SANDBOX/xdg-state"
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

DEVNET_DIR="$XDG_DATA_HOME/offckb-nodejs/devnet"

log "sandbox: $SANDBOX"

# --- Install both CLIs --------------------------------------------------------

log "installing old offckb @ $OLD_OFFCKB_VERSION from npm..."
mkdir -p "$SANDBOX/old-cli"
(
  cd "$SANDBOX/old-cli"
  npm init -y >/dev/null 2>&1
  npm install --cache "$NPM_CACHE_DIR" --no-audit --no-fund --loglevel=error "@offckb/cli@$OLD_OFFCKB_VERSION"
)
OLD_OFFCKB="$SANDBOX/old-cli/node_modules/.bin/offckb"
[ -x "$OLD_OFFCKB" ] || fail "old offckb install failed"

log "packing and installing current build..."
PKG_FILE="$(cd "$REPO_ROOT" && pnpm pack --pack-destination "$SANDBOX" 2>&1 | tail -1)"
[ -f "$PKG_FILE" ] || fail "pnpm pack failed: $PKG_FILE"
npm install -g --prefix "$SANDBOX/prefix" --cache "$NPM_CACHE_DIR" --no-audit --no-fund --loglevel=error "$PKG_FILE"
NEW_OFFCKB="$SANDBOX/prefix/bin/offckb"
[ -x "$NEW_OFFCKB" ] || fail "new offckb install failed"
NEW_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"

# --- Phase 1: old offckb creates legacy data ----------------------------------

log "phase 1: old offckb $OLD_OFFCKB_VERSION starts a devnet (downloads its legacy CKB on first run)..."
"$OLD_OFFCKB" node >"$SANDBOX/old-node.log" 2>&1 &
OLD_PID=$!

wait_for_rpc $RPC_PORT 300 "$OLD_PID" || fail "old node did not become ready (see $SANDBOX/old-node.log)"
wait_for_tip_at_least $RPC_PORT 3 120 "$OLD_PID" || fail "old node did not mine any blocks"

OLD_TIP="$(tip_number $RPC_PORT)"
OLD_GENESIS="$(rpc_result $RPC_PORT get_block_hash '["0x0"]')"
[ -n "$OLD_GENESIS" ] || fail "could not read genesis hash from old node"
log "old chain: tip=$OLD_TIP genesis=$OLD_GENESIS"

[ -f "$DEVNET_DIR/ckb.toml" ] || fail "old node did not create $DEVNET_DIR/ckb.toml"
if grep -q '"Terminal"' "$DEVNET_DIR/ckb.toml"; then
  fail "precondition broken: legacy ckb.toml already contains the Terminal module"
fi
grep -Eq '^[[:space:]]*#[[:space:]]*tcp_listen_address' "$DEVNET_DIR/ckb.toml" \
  || fail "precondition broken: legacy ckb.toml does not have a commented tcp_listen_address"
cp "$DEVNET_DIR/ckb.toml" "$SANDBOX/ckb.toml.legacy"
sha256 "$DEVNET_DIR/specs/dev.toml" >"$SANDBOX/dev.toml.legacy.sha256"

log "stopping old node..."
stop_phase "$OLD_PID"
OLD_PID=""
wait_for_port_closed $RPC_PORT 30 || fail "old node did not release port $RPC_PORT"

# --- Phase 2: current build on the legacy data --------------------------------

# Best-effort: reuse this machine's already-installed current CKB binary.
CURRENT_CKB_VERSION="$("$NEW_OFFCKB" config get ckb-version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
if [ -n "$CURRENT_CKB_VERSION" ] && [ -d "$REAL_DATA_HOME/offckb-nodejs/bins/$CURRENT_CKB_VERSION" ]; then
  log "seeding CKB $CURRENT_CKB_VERSION binary from local offckb cache..."
  mkdir -p "$XDG_DATA_HOME/offckb-nodejs/bins"
  cp -r "$REAL_DATA_HOME/offckb-nodejs/bins/$CURRENT_CKB_VERSION" "$XDG_DATA_HOME/offckb-nodejs/bins/" || true
fi

log "phase 2: offckb $NEW_VERSION starts on the legacy data..."
"$NEW_OFFCKB" node >"$SANDBOX/new-node.log" 2>&1 &
NEW_PID=$!

# The RPC proxy only starts after the node, miner and proxy are all up.
wait_for_rpc $PROXY_PORT 300 "$NEW_PID" || fail "upgraded node did not become ready (see $SANDBOX/new-node.log)"

log "asserting chain continuity..."
NEW_GENESIS="$(rpc_result $PROXY_PORT get_block_hash '["0x0"]')"
[ "$NEW_GENESIS" = "$OLD_GENESIS" ] \
  || fail "genesis hash changed ($OLD_GENESIS → $NEW_GENESIS): the legacy chain was reset!"
wait_for_tip_at_least $PROXY_PORT $((OLD_TIP + 1)) 90 "$NEW_PID" \
  || fail "tip did not grow past the old tip ($OLD_TIP): the chain is not continuing"
NEW_TIP="$(tip_number $PROXY_PORT)"
log "chain continued: tip $OLD_TIP → $NEW_TIP, genesis unchanged"

log "asserting legacy ckb.toml migration..."
grep -q '"Terminal"' "$DEVNET_DIR/ckb.toml" \
  || fail "legacy ckb.toml was not migrated: Terminal RPC module missing"
grep -Eq '^[[:space:]]*tcp_listen_address[[:space:]]*=' "$DEVNET_DIR/ckb.toml" \
  || fail "legacy ckb.toml was not migrated: tcp_listen_address not enabled"

log "asserting chain spec untouched..."
( cd "$DEVNET_DIR" && sha256 -c "$SANDBOX/dev.toml.legacy.sha256" >/dev/null ) \
  || fail "specs/dev.toml was modified during upgrade — user chain config must be preserved"

log "asserting a fresh transfer works on the upgraded chain..."
FROM_KEY="$(node -p "require('$REPO_ROOT/account/account.json')[0].privkey")"
TO_ADDR="$(node -p "require('$REPO_ROOT/account/account.json')[1].address")"
TRANSFER_OUT="$("$NEW_OFFCKB" transfer "$TO_ADDR" 100 --privkey "$FROM_KEY" --network devnet 2>&1)" \
  || { echo "$TRANSFER_OUT"; fail "transfer command failed"; }
echo "$TRANSFER_OUT"
TX_HASH="$(echo "$TRANSFER_OUT" | grep -oE '0x[0-9a-f]{64}' | head -1)"
[ -n "$TX_HASH" ] || fail "no transaction hash in transfer output"
COMMITTED=0
for ((i = 0; i < 45; i++)); do
  if rpc $PROXY_PORT get_transaction "[\"$TX_HASH\"]" 2>/dev/null | grep -q '"status":"committed"'; then
    COMMITTED=1
    break
  fi
  sleep 2
done
[ "$COMMITTED" = "1" ] || fail "transfer tx $TX_HASH was not committed on the upgraded chain"

log "stopping upgraded node..."
stop_phase "$NEW_PID"
NEW_PID=""

echo ""
echo "==============================================================="
echo "✓ Legacy data upgrade test passed (offckb $OLD_OFFCKB_VERSION → $NEW_VERSION)"
echo "==============================================================="
exit 0
