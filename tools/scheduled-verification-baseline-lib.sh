# Shared preconditions of the GH315 reviewed-candidate baselines (#358),
# sourced by tools/scheduled-verification-review-baseline.sh and
# tools/scheduled-verification-review2-baseline.sh (run as `sh <script>`).
# Each check refuses with exit 2 and a message naming what is missing, so a
# setup failure is never read as behavioral RED. A refusal EXITS the shell
# that sourced this file: call these from a script, never a long-lived shell.

# A revision handed to git must be a plain revision — a hash or a simple ref
# name, optionally with ^/~ suffixes — never something git would read as an
# option or a range (`a..b`, `^a`, `a^-n`), nor one of these spellings no
# ref can have: a leading `~`, `/` or `.`, a component starting with `.`,
# `//`, a trailing `/` or `.`, or a component ending in `.lock`. (The ^/~
# suffix grammar itself is left to git, which refuses by its own message.)
plain_revision() {
  case "$1" in ''|-*|^*|~*|/*|.*|*/.*|*..*|*^-*|*//*|*/|*.|*.lock|*.lock/*|*[!0-9A-Za-z_./^~-]*) return 1;; esac
}

# require_pinned_sources <candidate> <regressions> <file>...: every pinned
# revision and file is in this clone (a shallow checkout lacks them).
# Called before anything is created; its own arguments are checked first.
require_pinned_sources() {
  [ "$#" -ge 3 ] || { echo "require_pinned_sources needs a candidate, a regressions revision and at least one file (got $# arguments)" >&2; exit 2; }
  plain_revision "$1" || { echo "require_pinned_sources was given a candidate revision that is empty or not a plain revision: \"$1\"" >&2; exit 2; }
  plain_revision "$2" || { echo "require_pinned_sources was given a regressions revision that is empty or not a plain revision: \"$2\"" >&2; exit 2; }
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
  plain_revision "$2" || { echo "snapshot_candidate was given a candidate that is empty or not a plain revision: \"$2\"" >&2; exit 2; }
  # Trailing slashes dropped (`link/` is judged as the link it names); a last
  # component of `.` or `..`, or one that is not physically itself
  # (`link/.`), is no real directory.
  _snapshot_dir=$1
  while [ "${_snapshot_dir%/}" != "$_snapshot_dir" ] && [ "$_snapshot_dir" != / ]; do _snapshot_dir=${_snapshot_dir%/}; done
  case "$(basename -- "$_snapshot_dir")" in .|..|/) _snapshot_real=false;; *) _snapshot_real=true;; esac
  if [ "$_snapshot_real" = true ] && [ -d "$_snapshot_dir" ] && [ ! -L "$_snapshot_dir" ]; then
    { [ "$(cd -P -- "$_snapshot_dir" && pwd -P)" = "$(cd -P -- "$(dirname -- "$_snapshot_dir")" && pwd -P)/$(basename -- "$_snapshot_dir")" ]; } 2>/dev/null || _snapshot_real=false
  fi
  if [ "$_snapshot_real" != true ] || [ -L "$_snapshot_dir" ] || [ ! -d "$_snapshot_dir" ] || ! _snapshot_entries=$(ls -A -- "$_snapshot_dir") || [ -n "$_snapshot_entries" ]; then
    echo "snapshot directory $1 must be an existing, empty, real directory" >&2
    exit 2
  fi
  _snapshot_archive=$(mktemp "${TMPDIR:-/tmp}/gru-gh315-archive.XXXXXX") || { echo "snapshot_candidate could not create its archive file" >&2; exit 2; }
  if git archive -o "$_snapshot_archive" "$2" && tar -x -C "$_snapshot_dir" -f "$_snapshot_archive"; then
    rm -f "$_snapshot_archive"
  else
    rm -rf -- "$_snapshot_dir" "$_snapshot_archive"
    echo "reviewed candidate $2 could not be archived into $1 — refusing" >&2
    exit 2
  fi
}

# require_built_helper: run inside the built snapshot. The status
# regression's helper must exist AND load (every import resolves, and the
# load finishes) — a missing, broken, exiting or hanging helper would render
# exactly like the action's own rejection. The load runs in a child process
# killed (SIGKILL, with every descendant: it leads its own process group) at
# the bound — GRU_HELPER_LOAD_MS, a whole number from 1 to 3600000 written
# without leading zeros, default 60000 — writing to a file rather than a pipe,
# so neither a spinning helper, one that ignores SIGTERM, nor a descendant in
# its group holding its output open can stall the baseline or outlive it (a
# descendant that leaves the group with setsid is beyond this reach). A load
# stopped by a signal is said so, with its status, never as a broken helper;
# the four signals the guard handles (SIGINT, SIGTERM, SIGHUP, SIGQUIT) take
# its group and temporary directory down first — SIGKILL, or a signal sent to
# the shell alone, reaches no handler and leaves both behind. A load that
# could not run at all (no temporary directory, no process) is said so, never
# as a broken helper either. A per-run
# sentinel, on its own line, proves the load finished (against accidental
# output; the helper under test can read its own command line). Importing never runs the CLI (it runs only when
# invoked directly). A refused snapshot is kept for inspection.
require_built_helper() {
  test -s dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (check the build output; snapshot kept at $PWD)" >&2; exit 2; }
  _helper_load_ms=${GRU_HELPER_LOAD_MS:-60000}
  # The length check keeps an all-digit value too long for the shell to
  # compare (which it would treat as false, passing it) out.
  case "$_helper_load_ms" in ''|0*|*[!0-9]*) _helper_bound_ok=false;; *) _helper_bound_ok=true;; esac
  if [ "$_helper_bound_ok" != true ] || [ "${#_helper_load_ms}" -gt 7 ] || [ "$_helper_load_ms" -lt 1 ] || [ "$_helper_load_ms" -gt 3600000 ]; then
    echo "GRU_HELPER_LOAD_MS must be a whole number of milliseconds from 1 to 3600000, without leading zeros (got \"$_helper_load_ms\")" >&2
    exit 2
  fi
  if GRU_HELPER_LOAD_MS="$_helper_load_ms" node --input-type=module - <<'JS'
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ms = Number(process.env.GRU_HELPER_LOAD_MS);
const sentinel = `gru-helper-loaded-${randomUUID()}`;
let dir;
let failure = null;
// Set when the load never ran far enough to judge the helper.
let couldNotRun = false;
let child;
// The group is probed before it is signalled: that narrows, but cannot
// close, the window in which a reaped leader's id names some other group.
const killGroup = () => { if (child?.pid === undefined) return; try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ } };
// Taken before anything is made (the temporary directory, the load), so a
// signal the guard can handle never orphans either.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.once(signal, () => {
    killGroup();
    // The stop is said whatever the cleanup meets: a stray directory is the lesser loss.
    try { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); } catch { /* still stopped */ }
    process.exit(130);
  });
}
try { dir = mkdtempSync(join(tmpdir(), 'gru-helper-load-')); } catch (error) {
  console.error(`the helper load could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(4);
}
try {
  const out = openSync(join(dir, 'stdout'), 'w');
  try {
    const load = `await import('./dist/verify/capture-cli.js'); process.stdout.write(${JSON.stringify(`\n${sentinel}\n`)}, () => process.exit(0));`;
    child = spawn(process.execPath, ['--input-type=module', '-e', load], { detached: true, stdio: ['ignore', out, 'inherit'] });
  } finally { closeSync(out); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, ms);
  const [[code, signal]] = await Promise.race([once(child, 'exit').then((args) => [args]), once(child, 'error').then(([error]) => { throw error; })]);
  clearTimeout(timer);
  // Whatever the load left running goes with it.
  killGroup();
  const stdout = readFileSync(join(dir, 'stdout'), 'utf8');
  if (timedOut) failure = `the helper did not finish loading within ${String(ms)} ms`;
  else if (code !== 0) failure = `the helper exited ${String(code ?? signal)} while loading`;
  else if (!stdout.split('\n').includes(sentinel)) failure = 'the helper stopped before it finished loading';
} catch (error) {
  couldNotRun = true;
  failure = `the helper load could not run: ${error instanceof Error ? error.message : String(error)}`;
} finally {
  // A cleanup error never replaces the verdict: a stray directory is the lesser loss.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the verdict stands */ }
}
if (failure !== null) { console.error(failure); process.exit(couldNotRun ? 4 : 3); }
JS
  then
    :
  else
    _helper_status=$?
    # A load stopped by a signal (handled: 130; or not) judged nothing about the helper.
    if [ "$_helper_status" -ge 128 ]; then
      echo "the helper load was stopped by a signal (status $_helper_status) — nothing was judged; refusing (snapshot kept at $PWD)" >&2
      exit "$_helper_status"
    fi
    if [ "$_helper_status" -eq 4 ]; then
      echo "the helper load could not run — nothing was judged about the helper; refusing (snapshot kept at $PWD)" >&2
      exit 2
    fi
    echo "the built dist/verify/capture-cli.js does not load cleanly — a broken helper would read as behavioral RED; refusing (snapshot kept at $PWD)" >&2
    exit 2
  fi
}
