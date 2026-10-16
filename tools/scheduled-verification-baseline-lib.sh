# Shared preconditions of the GH315 reviewed-candidate baselines (#358),
# sourced by tools/scheduled-verification-review-baseline.sh and
# tools/scheduled-verification-review2-baseline.sh (run as `sh <script>`).
# Each check refuses with exit 2 and a message naming what is missing, so a
# setup failure is never read as behavioral RED. A refusal EXITS the shell
# that sourced this file: call these from a script, never a long-lived shell.

# A revision handed to git must be a plain name (a hash or ref), never
# something git would read as an option.
plain_revision() {
  case "$1" in ''|-*|*[!0-9A-Za-z_./^~-]*) return 1;; esac
}

# require_pinned_sources <candidate> <regressions> <file>...: every pinned
# revision and file is in this clone (a shallow checkout lacks them).
# Called before anything is created; its own arguments are checked first.
require_pinned_sources() {
  [ "$#" -ge 3 ] || { echo "require_pinned_sources needs a candidate, a regressions revision and at least one file (got $# arguments)" >&2; exit 2; }
  plain_revision "$1" || { echo "require_pinned_sources was given a candidate revision that is empty or not a plain name: \"$1\"" >&2; exit 2; }
  plain_revision "$2" || { echo "require_pinned_sources was given a regressions revision that is empty or not a plain name: \"$2\"" >&2; exit 2; }
  _pinned_candidate=$1
  _pinned_regressions=$2
  shift 2
  for _pinned_file in "$@"; do
    [ -n "$_pinned_file" ] || { echo "require_pinned_sources was given an empty file name" >&2; exit 2; }
  done
  git cat-file -e "${_pinned_candidate}^{commit}" 2>/dev/null || { echo "reviewed candidate ${_pinned_candidate} is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  git cat-file -e "${_pinned_regressions}^{commit}" 2>/dev/null || { echo "regressions revision ${_pinned_regressions} is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  for _pinned_file in "$@"; do
    git cat-file -e "${_pinned_regressions}:${_pinned_file}" 2>/dev/null || { echo "pinned regression file ${_pinned_file} is missing at ${_pinned_regressions} — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  done
}

# snapshot_candidate <dir> <candidate>: the candidate's tree, extracted into
# the snapshot directory, which must be a real (not linked), existing, empty
# directory (it is removed on failure). Archived first to a file outside it,
# so a failing archive is seen (a pipe reports only tar's status); a failed
# archive or extraction removes the partial snapshot and the archive, and
# refuses.
snapshot_candidate() {
  [ "$#" -eq 2 ] && [ -n "$1" ] || { echo "snapshot_candidate needs a snapshot directory and a candidate" >&2; exit 2; }
  plain_revision "$2" || { echo "snapshot_candidate was given a candidate that is empty or not a plain name: \"$2\"" >&2; exit 2; }
  if [ -L "$1" ] || [ ! -d "$1" ] || ! _snapshot_entries=$(ls -A -- "$1") || [ -n "$_snapshot_entries" ]; then
    echo "snapshot directory $1 must be an existing, empty, real directory" >&2
    exit 2
  fi
  _snapshot_archive=$(mktemp "${TMPDIR:-/tmp}/gru-gh315-archive.XXXXXX") || { echo "snapshot_candidate could not create its archive file" >&2; exit 2; }
  if git archive -o "$_snapshot_archive" "$2" && tar -x -C "$1" -f "$_snapshot_archive"; then
    rm -f "$_snapshot_archive"
  else
    rm -rf "$1" "$_snapshot_archive"
    echo "reviewed candidate $2 could not be archived into $1 — refusing" >&2
    exit 2
  fi
}

# require_built_helper: run inside the built snapshot. The status
# regression's helper must exist AND load (every import resolves, and the
# load finishes) — a missing, broken, exiting or hanging helper would render
# exactly like the action's own rejection. The load runs in a child process
# killed (SIGKILL) at the bound — GRU_HELPER_LOAD_MS, a whole number from 1 to
# 3600000, default 60000 — writing to a file rather than a pipe, so neither a
# spinning helper, one that ignores SIGTERM, nor a descendant holding its
# output open can stall the baseline. A per-run sentinel, on its own line,
# proves the load finished. Importing never runs the CLI (it runs only when
# invoked directly). A refused snapshot is kept for inspection.
require_built_helper() {
  test -s dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (check the build output; snapshot kept at $PWD)" >&2; exit 2; }
  _helper_load_ms=${GRU_HELPER_LOAD_MS:-60000}
  case "$_helper_load_ms" in ''|*[!0-9]*) _helper_bound_ok=false;; *) _helper_bound_ok=true;; esac
  if [ "$_helper_bound_ok" != true ] || [ "${#_helper_load_ms}" -gt 7 ] || [ "$_helper_load_ms" -lt 1 ] || [ "$_helper_load_ms" -gt 3600000 ]; then
    echo "GRU_HELPER_LOAD_MS must be a whole number of milliseconds from 1 to 3600000 (got \"$_helper_load_ms\")" >&2
    exit 2
  fi
  if ! GRU_HELPER_LOAD_MS="$_helper_load_ms" node --input-type=module - <<'JS'
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ms = Number(process.env.GRU_HELPER_LOAD_MS);
const sentinel = `gru-helper-loaded-${randomUUID()}`;
const dir = mkdtempSync(join(tmpdir(), 'gru-helper-load-'));
const out = openSync(join(dir, 'stdout'), 'w');
let run;
try {
  const load = `await import('./dist/verify/capture-cli.js'); process.stdout.write(${JSON.stringify(`\n${sentinel}\n`)}, () => process.exit(0));`;
  run = spawnSync(process.execPath, ['--input-type=module', '-e', load], { timeout: ms, killSignal: 'SIGKILL', stdio: ['ignore', out, 'inherit'] });
} finally { closeSync(out); }
const stdout = readFileSync(join(dir, 'stdout'), 'utf8');
rmSync(dir, { recursive: true, force: true });
if (run.error !== undefined) {
  console.error(run.error.code === 'ETIMEDOUT' ? `the helper did not finish loading within ${String(ms)} ms` : `the helper load could not run: ${run.error.message}`);
  process.exit(3);
}
if (run.status !== 0) { console.error(`the helper exited ${String(run.status ?? run.signal)} while loading`); process.exit(3); }
if (!stdout.split('\n').includes(sentinel)) { console.error('the helper stopped before it finished loading'); process.exit(3); }
JS
  then
    echo "the built dist/verify/capture-cli.js does not load cleanly — a broken helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2
    exit 2
  fi
}
