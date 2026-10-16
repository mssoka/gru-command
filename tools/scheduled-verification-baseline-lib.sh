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
# the (empty) snapshot directory. Archived to a file first so a failing
# archive is seen (a pipe reports only tar's status); a failed archive or
# extraction removes the partial snapshot and its archive, and refuses.
snapshot_candidate() {
  if git archive -o "$1.tar" "$2" && tar -x -C "$1" -f "$1.tar"; then
    rm -f "$1.tar"
  else
    rm -rf "$1" "$1.tar"
    echo "reviewed candidate $2 could not be archived into $1 — refusing" >&2
    exit 2
  fi
}

# require_built_helper: run inside the built snapshot. The status
# regression's helper must exist AND load (every import resolves) within a
# bound — a missing, broken, exiting or hanging helper would render exactly
# like the action's own rejection. Importing never runs the CLI (it runs only
# when invoked directly). A refused snapshot is kept for inspection.
require_built_helper() {
  test -s dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (check the build output; snapshot kept at $PWD)" >&2; exit 2; }
  _helper_loaded=$(GRU_HELPER_LOAD_MS="${GRU_HELPER_LOAD_MS:-60000}" node --input-type=module -e "
setTimeout(() => { console.error('the helper did not finish loading within ' + process.env.GRU_HELPER_LOAD_MS + ' ms'); process.exit(3); }, Number(process.env.GRU_HELPER_LOAD_MS)).unref();
await import('./dist/verify/capture-cli.js');
console.log('gru-helper-loaded');
process.exit(0);
") || true
  [ "$_helper_loaded" = gru-helper-loaded ] || { echo "the built dist/verify/capture-cli.js does not load cleanly — a broken helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2; exit 2; }
}
