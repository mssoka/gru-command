#!/bin/sh
# #534 fail-before proof: the changed test-side files at the candidate head
# run against an isolated git-archive snapshot of the BASE
# ccd6337fb629f3fc69bea725d06873733b363182, where a worktree process's command
# line was recorded, returned and handed on as `ps` listed it. Expected result
# is RED by BEHAVIORAL ASSERTION on the three named cases:
#   A1  the real-`ps` sweep: the release() paused result, the
#       worktree_processes row, the worktree.paused payload and every
#       onSweepPaused detail carried the credentials;
#   A2  the ledger's registry-evidence write stored them;
#   A3  redactCredentials did not mask `--token <v>`, `-u <user>:<v>` or
#       `Authorization: token <v>`.
# The fast files and the heavy file run under their own Vitest configs; their
# JSON reports are merged and classified once by
# tools/assert-named-red-baseline.mjs, which exits 2 (FAILS-BEFORE CLAIM
# BROKEN) on a collection/setup/import failure, a named case that did not fail
# as an assertion, a missing named case or an unreadable report. A leg that
# passed unexpectedly exits 2 as well. The snapshot and the ignored pointer
# file are preserved for inspection; nothing is checked out; dependencies are
# only symlinked, never installed; the lane checkout is never mutated.
set -eu
base=ccd6337fb629f3fc69bea725d06873733b363182
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-gc-534-red.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
# Every test-side file the change adds or edits (tests and helpers), as
# committed at the candidate head.
git diff --name-only --diff-filter=AM "$base" "$headrev" -- test | while IFS= read -r f; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/gc-534-red-baseline.last-snapshot.txt"
cd "$d"
a1='redacts argv credentials in every recorded and returned process command'
a2='redacts argv credentials in the verify registry write'
a3='redacts argv credentials: new token, user and auth-scheme forms'
for pair in "worktree-manager:$a1" "ledger-api:$a2" "redaction:$a3"; do
  file=${pair%%:*}
  title=${pair#*:}
  if ! grep -qF "it('$title'" "test/$file.test.ts"; then
    echo "gc-534 registration guard failed: test/$file.test.ts does not register \"$title\"" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/fast-results.json" test/redaction.test.ts test/ledger-api.test.ts -t '^redacts argv credentials'
fast=$?
npx vitest run --reporter=json --outputFile="$d/heavy-results.json" --config vitest.heavy.config.ts test/worktree-manager.test.ts -t '^redacts argv credentials'
heavy=$?
set -e
echo "gc-534-red-baseline vitest exits: fast=$fast heavy=$heavy"
if [ "$fast" -eq 0 ] || [ "$heavy" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: a leg passed the argv-redaction regressions against the base unexpectedly" >&2
  exit 2
fi
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const [out, ...inputs] = process.argv.slice(1);
  const reports = inputs.map((file) => JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(out, JSON.stringify({
    numFailedTests: reports.reduce((sum, report) => sum + report.numFailedTests, 0),
    testResults: reports.flatMap((report) => report.testResults),
  }));
' "$d/results.json" "$d/fast-results.json" "$d/heavy-results.json"
node "$root/tools/assert-named-red-baseline.mjs" gc-534 "$d/results.json" "$a1" "$a2" "$a3" || exit 2
echo "EXPECTED-NONZERO: the argv-redaction regressions A1-A3 failed behaviorally against the unredacted base"
exit 1
