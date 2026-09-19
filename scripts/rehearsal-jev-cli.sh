#!/usr/bin/env bash
# Isolated installer ↔ real Jev CLI contract proof. No provider request is made:
# check runs with decisions disabled and must report disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JEV_REF="${JEV_REF:-189a49d49ea9d16ec37546be80ed8e643347eb32}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gru-command-jev-cli.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

JEV_TREE="$STAGE/jev"
INSTANCE="$STAGE/instance"
mkdir -p "$JEV_TREE" "$INSTANCE"

git -C "$ROOT" archive "$JEV_REF" | tar -x -C "$JEV_TREE"
ln -s "$ROOT/node_modules" "$JEV_TREE/node_modules"
(
  cd "$JEV_TREE"
  npm run build >/dev/null
)

npm --prefix "$ROOT" run build >/dev/null
# Resolve macOS /tmp → /private/tmp so the current sibling CLI's raw main
# guard executes; the ownership lane has been notified to normalize it.
REAL_CLI="$(cd "$JEV_TREE/dist/decisions" && pwd -P)/cli.js"
[[ -f "$REAL_CLI" ]] || { echo "FAIL: no real CLI at $REAL_CLI" >&2; exit 1; }

GRU_COMMAND_HOME="$INSTANCE" \
GRU_COMMAND_TEST_DECISIONS_CLI="$REAL_CLI" \
  node "$ROOT/dist/cli/config-generate.js" >"$STAGE/generate.out"

grep -q '^\[decisions\.jev\]$' "$INSTANCE/config.toml"
grep -q '^enabled = false ' "$INSTANCE/config.toml"

STATUS_BEFORE="$(env -u OPENROUTER_API_KEY GRU_COMMAND_HOME="$INSTANCE" node "$REAL_CLI" status --json)"
printf '%s' "$STATUS_BEFORE" | grep -q '"enabled":false'
printf '%s' "$STATUS_BEFORE" | grep -q '"credential_present":false'

SECRET='sk-or-v1-isolated-contract-only'
printf '%s\n' "$SECRET" | env -u OPENROUTER_API_KEY GRU_COMMAND_HOME="$INSTANCE" \
  node "$REAL_CLI" credentials set --stdin >"$STAGE/set.out"
grep -q '"ok":true' "$STAGE/set.out"
[[ "$(stat -f '%Lp' "$INSTANCE/credentials" 2>/dev/null || stat -c '%a' "$INSTANCE/credentials")" == "700" ]]
[[ "$(stat -f '%Lp' "$INSTANCE/credentials/openrouter.key" 2>/dev/null || stat -c '%a' "$INSTANCE/credentials/openrouter.key")" == "600" ]]

STATUS_AFTER="$(env -u OPENROUTER_API_KEY GRU_COMMAND_HOME="$INSTANCE" node "$REAL_CLI" status --json)"
printf '%s' "$STATUS_AFTER" | grep -q '"credential_present":true'
printf '%s' "$STATUS_AFTER" | grep -q '"credential_source":"file"'
CHECK="$(env -u OPENROUTER_API_KEY GRU_COMMAND_HOME="$INSTANCE" node "$REAL_CLI" check --json)"
printf '%s' "$CHECK" | grep -q '"status":"disabled"'

node "$REAL_CLI" config-template --enabled true >"$STAGE/enabled-fragment.toml"
grep -q '^enabled = true ' "$STAGE/enabled-fragment.toml"

if grep -R -F "$SECRET" "$INSTANCE/config.toml" "$STAGE/generate.out" "$STAGE/set.out" \
  "$STAGE/enabled-fragment.toml" >/dev/null; then
  echo 'FAIL: credential leaked outside protected store' >&2
  exit 1
fi

printf 'PASS real Jev CLI seam ref=%s\n' "$JEV_REF"
printf 'status-before=%s\nstatus-after=%s\ncheck=%s\n' "$STATUS_BEFORE" "$STATUS_AFTER" "$CHECK"
