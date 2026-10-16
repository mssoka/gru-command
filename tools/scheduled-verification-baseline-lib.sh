# Shared preconditions of the GH315 reviewed-candidate baselines (#358),
# sourced by tools/scheduled-verification-review-baseline.sh and
# tools/scheduled-verification-review2-baseline.sh (run as `sh <script>`).
# Each check refuses with exit 2 and a message naming what is missing, so a
# setup failure is never read as behavioral RED. A refusal EXITS the shell
# that sourced this file: call these from a script, never a long-lived shell.

# require_pinned_sources <candidate> <regressions> <file>...: every pinned
# revision and file is in this clone (a shallow checkout lacks them).
# Called before anything is created.
require_pinned_sources() {
  [ "$#" -ge 3 ] || { echo "require_pinned_sources needs a candidate, a regressions revision and at least one file (got $# arguments)" >&2; exit 2; }
  [ -n "$1" ] && [ -n "$2" ] || { echo "require_pinned_sources was given an empty revision" >&2; exit 2; }
  git cat-file -e "${1}^{commit}" 2>/dev/null || { echo "reviewed candidate $1 is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  git cat-file -e "${2}^{commit}" 2>/dev/null || { echo "regressions revision $2 is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  _pinned_regressions=$2
  shift 2
  for _pinned_file in "$@"; do
    [ -n "$_pinned_file" ] || { echo "require_pinned_sources was given an empty file name" >&2; exit 2; }
    git cat-file -e "${_pinned_regressions}:${_pinned_file}" 2>/dev/null || { echo "pinned regression file ${_pinned_file} is missing at ${_pinned_regressions} — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  done
}

# snapshot_candidate <dir> <candidate>: the candidate's tree, extracted into
# the snapshot directory, which must exist and be empty (it is removed on
# failure). Archived to a file first so a failing archive is seen (a pipe
# reports only tar's status); a failed archive or extraction removes the
# partial snapshot and its archive, and refuses.
snapshot_candidate() {
  [ "$#" -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || { echo "snapshot_candidate needs a snapshot directory and a candidate" >&2; exit 2; }
  [ -d "$1" ] && [ -z "$(ls -A "$1")" ] || { echo "snapshot directory $1 must exist and be empty" >&2; exit 2; }
  if git archive -o "$1.tar" "$2" && tar -x -C "$1" -f "$1.tar"; then
    rm -f "$1.tar"
  else
    rm -rf "$1" "$1.tar"
    echo "reviewed candidate $2 could not be archived into $1 — refusing" >&2
    exit 2
  fi
}

# require_built_helper: run inside the built snapshot. The status
# regression's helper must exist AND load (every import resolves, and the
# load finishes) — a missing, broken, exiting or hanging helper would render
# exactly like the action's own rejection. The load runs in a child process
# killed at the bound (GRU_HELPER_LOAD_MS, default 60000), so even a helper
# that spins synchronously cannot stall the baseline. Importing never runs
# the CLI (it runs only when invoked directly). A refused snapshot is kept
# for inspection.
require_built_helper() {
  test -s dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (check the build output; snapshot kept at $PWD)" >&2; exit 2; }
  _helper_load_ms=${GRU_HELPER_LOAD_MS:-60000}
  case "$_helper_load_ms" in ''|0|*[!0-9]*) echo "GRU_HELPER_LOAD_MS must be a positive whole number of milliseconds (got \"$_helper_load_ms\")" >&2; exit 2;; esac
  if ! GRU_HELPER_LOAD_MS="$_helper_load_ms" node --input-type=module - <<'JS'
import { spawnSync } from 'node:child_process';
const ms = Number(process.env.GRU_HELPER_LOAD_MS);
const load = "await import('./dist/verify/capture-cli.js'); process.stdout.write('gru-helper-loaded\\n', () => process.exit(0));";
const run = spawnSync(process.execPath, ['--input-type=module', '-e', load], { timeout: ms, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
if (run.error !== undefined && run.error.code === 'ETIMEDOUT') { console.error(`the helper did not finish loading within ${String(ms)} ms`); process.exit(3); }
if (run.status !== 0) { console.error(`the helper exited ${String(run.status ?? run.signal)} while loading`); process.exit(3); }
if (run.stdout.trimEnd().split('\n').pop() !== 'gru-helper-loaded') { console.error('the helper stopped before it finished loading'); process.exit(3); }
JS
  then
    echo "the built dist/verify/capture-cli.js does not load cleanly — a broken helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2
    exit 2
  fi
}
