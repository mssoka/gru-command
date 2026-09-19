#!/usr/bin/env bash
# Gru Command — install rehearsal (E9 acceptance).
#
# Proves the README's promise on a machine (fixture HOME) that has never
# seen Gru Command: pristine home + workspace containing two dummy git
# repos, a FRESH file:// clone of THIS checkout, non-interactive
# install.sh (deps → build → wizard), a schema-valid config, and
# first-boot /health smoke — all inside the fixture, touching nothing of
# the developer's real instance.
#
# Requires network for `npm install` in the fresh clone. Run on demand:
#   bash scripts/rehearsal.sh
# and paste the output (evidence) into the PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/gru-command-rehearsal-XXXXXX")"
HOME_FIXTURE="$STAGE/home"
WORKSPACE="$STAGE/workspace"
TARGET="$HOME_FIXTURE/gru-command"
INSTANCE="$HOME_FIXTURE/.gru-command"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }

step "stage: pristine fixture home + workspace with two dummy git repos"
mkdir -p "$HOME_FIXTURE" "$WORKSPACE"
for repo in repo-alpha repo-beta; do
  git init -q "$WORKSPACE/$repo"
  touch "$WORKSPACE/$repo/README"
  git -C "$WORKSPACE/$repo" add README
  git -C "$WORKSPACE/$repo" -c user.email=rehearsal@example.invalid \
    -c user.name=rehearsal commit -qm "rehearsal fixture"
done
echo "home:     $HOME_FIXTURE (empty)"
echo "workspace: $WORKSPACE ($(ls "$WORKSPACE" | tr '\n' ' '))"

step "install: one-line path against the fresh clone (non-interactive)"
# Simulate the actual one-liner: the script runs from a bare location
# with NO checkout around it (curl | bash has no repo context), so the
# clone-when-absent path is what executes.
BARE="$STAGE/bare"
mkdir -p "$BARE"
cp "$REPO_ROOT/install.sh" "$BARE/install.sh"
ANSWERS="$(printf '{"workspace_root":"%s","repos":["repo-alpha","repo-beta"],"port":0,"token":"rehearsal-pairing-token","register_service":false}' "$WORKSPACE")"
echo "answers: $ANSWERS"
env -u GRU_COMMAND_HOME \
  HOME="$HOME_FIXTURE" \
  GRU_COMMAND_ORIGIN="file://$REPO_ROOT" \
  GRU_COMMAND_TARGET="$TARGET" \
  GRU_COMMAND_HOME="$INSTANCE" \
  bash "$BARE/install.sh" --answers "$ANSWERS"

step "verify: clone landed, wizard wrote a schema-valid config"
[[ -f "$TARGET/dist/main.js" ]] || { echo "FAIL: no dist/main.js in the clone"; exit 1; }
[[ -f "$INSTANCE/config.toml" ]] || { echo "FAIL: wizard wrote no config.toml"; exit 1; }
grep -q 'workspace_root' "$INSTANCE/config.toml"
grep -q 'rehearsal-pairing-token' "$INSTANCE/config.toml"
echo "clone:    $TARGET"
echo "config:   $INSTANCE/config.toml"

step "PASS — fresh-clone install + first-boot smoke green on the fixture home"
echo "(the wizard's smoke step already asserted 3-signal liveness +"
echo " fingerprint + clean shutdown; its exit code gated this line)"
