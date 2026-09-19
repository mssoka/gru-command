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

# The clone rehearses HEAD, not the working tree — a dirty tree would
# silently rehearse stale code. Commit first.
if ! (git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet); then
  echo "rehearsal.sh: working tree is dirty — the fresh clone would rehearse HEAD, not your edits." >&2
  echo "commit first (git add -A && git commit), then re-run." >&2
  exit 1
fi

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
  bash "$BARE/install.sh" --answers "$ANSWERS" 2>&1 | tee "$STAGE/install.log"

step "verify: clone landed, wizard wrote a schema-valid config, smoke ran"
[[ -f "$TARGET/dist/main.js" ]] || { echo "FAIL: no dist/main.js in the clone"; exit 1; }
[[ -f "$INSTANCE/config.toml" ]] || { echo "FAIL: wizard wrote no config.toml"; exit 1; }
grep -q 'workspace_root' "$INSTANCE/config.toml"
grep -q 'rehearsal-pairing-token' "$INSTANCE/config.toml"
# Smoke EVIDENCE, not exit-code trust: a wizard that silently skipped the
# smoke would still exit 0 — the green line must be in the install output
# (Perkins r1 W7; mutation-verified the gate was partially vacuous without it).
grep -q 'Smoke green' "$STAGE/install.log" || {
  echo "FAIL: no 'Smoke green' line in the install output — the smoke did not run";
  exit 1;
}
echo "clone:    $TARGET"
echo "config:   $INSTANCE/config.toml"

step "PASS — fresh-clone install + first-boot smoke green on the fixture home"
echo "(asserted: 'Smoke green' present in the install output — 3-signal"
echo " liveness + fingerprint + clean shutdown reported by the wizard)"
