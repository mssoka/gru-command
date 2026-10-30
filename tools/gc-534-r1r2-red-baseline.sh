#!/bin/sh
# #534 continuation fail-before proof (review r6b findings R1 and R2): the
# changed test-side files at the candidate head run against an isolated
# git-archive snapshot of the stranded lane's last head
# 0e7d5f959f86529ef5bd4357d0c7393c902335c0, where a process row recorded and
# compared only the MASKED command line and the verification scheduler's events
# carried the command raw. Expected result is RED by BEHAVIORAL ASSERTION on
# the named cases:
#   R1  an answer recorded for another credential under the same masked
#       command killed the pid instead of asking again; a live row with no
#       digest was acknowledged by its masked text; a process write recorded no
#       raw-command digest; the ledger had no digest column; the terminal
#       readback closed a registry row by masked text (another credential, a
#       row with no digest);
#   R2  the verification events (requested, started, process-started,
#       completed, the dedupe key and a held job's refusal) carried the scope's
#       command raw, at the scheduler's record boundary and in the ledger.
# The fast files and the heavy files run under their own Vitest configs;
# their JSON reports are merged and classified once by
# tools/assert-named-red-baseline.mjs, which exits 2 (FAILS-BEFORE CLAIM
# BROKEN) on a collection/setup/import failure, a named case that did not fail
# as an assertion, a missing named case or an unreadable report. A leg that
# passed unexpectedly exits 2 as well. The snapshot and the ignored pointer
# file are preserved for inspection; nothing is checked out; dependencies are
# only symlinked, never installed; the lane checkout is never mutated.
set -eu
base=0e7d5f959f86529ef5bd4357d0c7393c902335c0
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-gc-534-r1r2.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
# Every test-side file the continuation adds or edits (tests and helpers), as
# committed at the candidate head.
git diff --name-only --diff-filter=AM "$base" "$headrev" -- test | while IFS= read -r f; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/gc-534-r1r2-red-baseline.last-snapshot.txt"
cd "$d"
r1_swap_inner='an answer recorded for another credential under the same masked command asks again and kills nothing'
r1_nodigest_inner='a live row recorded without a digest is asked about again even when its masked text matches'
r1_manager_describe='#534 R1: a process is the recorded one by the digest of its raw command line, never its masked text'
r1_ledger='records the SHA-256 of the raw command beside the masked command on every process write (#534 R1)'
r1_migration_inner='upgrades a v33 ledger adding the process command digest without touching existing rows, which keep no identity (#534)'
r1_identity_inner='closes a registry row at the terminal readback only by the digest of its raw command: another credential under the same masked text, and a row without a digest, stay live (#534 R1)'
r2_readback_inner='records a credential-bearing scope command masked in the lane process row, and the terminal readback still closes that row (#534)'
r2_scheduler='records every verification event with its command lines masked while the run keeps and spawns the raw command (#534 R2)'
r2_held_inner='records the held-job refusal with the scope command masked (#534 R2)'
for pair in "worktree-manager:$r1_swap_inner" "worktree-manager:$r1_nodigest_inner" "ledger-api:$r1_ledger" "ledger-db:$r1_migration_inner" "verification-server:$r1_identity_inner" "verification-server:$r2_readback_inner" "verification-server:$r2_held_inner" "verification-scheduler:$r2_scheduler"; do
  file=${pair%%:*}
  title=${pair#*:}
  if ! grep -qF "it('$title'" "test/$file.test.ts"; then
    echo "gc-534 registration guard failed: test/$file.test.ts does not register \"$title\"" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/fast-results.json" test/ledger-api.test.ts test/ledger-db.test.ts test/verification-scheduler.test.ts -t '#534'
fast=$?
npx vitest run --reporter=json --outputFile="$d/heavy-results.json" --config vitest.heavy.config.ts test/worktree-manager.test.ts test/verification-server.test.ts -t '#534'
heavy=$?
set -e
echo "gc-534-r1r2-red-baseline vitest exits: fast=$fast heavy=$heavy"
if [ "$fast" -eq 0 ] || [ "$heavy" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: a leg passed the R1/R2 regressions against the stranded lane's head unexpectedly" >&2
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
node "$root/tools/assert-named-red-baseline.mjs" gc-534-r1r2 "$d/results.json" \
  "$r1_manager_describe $r1_swap_inner" \
  "$r1_manager_describe $r1_nodigest_inner" \
  "$r1_ledger" \
  "ledger db + migration runner $r1_migration_inner" \
  "POST /api/verify $r1_identity_inner" \
  "POST /api/verify $r2_readback_inner" \
  "POST /api/verify $r2_held_inner" \
  "$r2_scheduler" || exit 2
echo "EXPECTED-NONZERO: R1 (raw-command digest identity) and R2 (masked verification events) regressions failed behaviorally against 0e7d5f95"
exit 1
