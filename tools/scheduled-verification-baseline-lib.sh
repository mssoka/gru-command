# Shared preconditions of the GH315 reviewed-candidate baselines (#358),
# sourced by tools/scheduled-verification-review-baseline.sh and
# tools/scheduled-verification-review2-baseline.sh. Each check refuses with
# exit 2 and a message naming what is missing, so a setup failure is never
# read as behavioral RED.

# require_pinned_sources <candidate> <regressions> <file>...: every pinned
# revision and file is in this clone (a shallow checkout lacks them).
# Called before anything is created.
require_pinned_sources() {
  git cat-file -e "${1}^{commit}" 2>/dev/null || { echo "reviewed candidate $1 is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  git cat-file -e "${2}^{commit}" 2>/dev/null || { echo "regressions revision $2 is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  _pinned_regressions=$2
  shift 2
  for _pinned_file in "$@"; do
    git cat-file -e "${_pinned_regressions}:${_pinned_file}" 2>/dev/null || { echo "pinned regression file ${_pinned_file} is missing at ${_pinned_regressions} — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  done
}

# require_built_helper: run inside the built snapshot. The status
# regression's helper must exist AND load (every import resolves) — a
# missing or broken helper would render exactly like the action's own
# rejection. Importing never runs the CLI: it runs only when invoked
# directly. A refused snapshot is kept for inspection.
require_built_helper() {
  test -s dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2; exit 2; }
  node --input-type=module -e "await import('./dist/verify/capture-cli.js')" || { echo "the built dist/verify/capture-cli.js does not load — a broken helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2; exit 2; }
}
