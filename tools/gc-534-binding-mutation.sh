#!/bin/sh
# #534 mutation check for the verification-event binding. A verification event
# is recorded with its command masked, and `recordsCommand` (src/ledger/api.ts)
# is what binds such an event to the raw command a run was submitted with: the
# terminal readback, the completed-event fence and the directive-retirement
# evidence gate all read events through it. This script extracts the candidate
# head into an isolated snapshot, applies ONE string edit that reduces the helper
# to strict equality (an event holding the masked command no longer binds), and
# runs the tests that cover it. Expected result is RED by BEHAVIORAL ASSERTION
# on the named cases:
#   the helper's own pin;
#   the readback test, whose masked started/process-started/completed events must
#     still close the run's registry row;
#   the retirement-gate guard, whose actual declared `full` command carries a
#     credential and whose masked events must still settle the gate.
# The edit is anchored: if the helper's text drifts and the anchor no longer
# matches exactly once, the script exits 2 (the claim is not proven) instead of
# running an unmutated tree. The fast and heavy legs run under their own Vitest
# configs, their JSON reports are merged and classified once by
# tools/assert-named-red-baseline.mjs, and the script exits nonzero by design
# (EXPECTED-NONZERO) after the classifier accepts the mutant run. Nothing is
# checked out; dependencies are only symlinked; the lane checkout is never mutated.
set -eu
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-mutation-gc-534.XXXXXX")
git archive "$headrev" -o "$d/head.tar"
tar -xf "$d/head.tar" -C "$d"
rm -f "$d/head.tar"
ln -s "$root/node_modules" "$d/node_modules"
printf '%s head=%s\n' "$d" "$headrev" > "$prep/gc-534-binding-mutation.last-snapshot.txt"
cd "$d"
# The edit program rides a quoted heredoc: an inner single quote in a `node -e '...'`
# string would end the shell quote and strip the anchor's own quotes.
node - <<'JS' || { echo "gc-534 mutation anchor guard failed" >&2; exit 2; }
const { readFileSync, writeFileSync } = require("node:fs");
const file = "src/ledger/api.ts";
const anchor = "return typeof recorded === 'string'\n    && (recorded === raw || recorded === redactCredentials(raw) || redactCredentials(recorded) === redactCredentials(raw));";
const text = readFileSync(file, "utf8");
const count = text.split(anchor).length - 1;
if (count !== 1) { process.stderr.write("mutation anchor matched " + count + " times in " + file + " (need exactly 1)\n"); process.exit(2); }
writeFileSync(file, text.replace(anchor, "return recorded === raw;"));
JS
helper='binds a verification event to its command by the raw line or its masked form, and no other (#534 R2)'
readback='records a credential-bearing scope command masked in the lane process row, and the terminal readback still closes that row (#534)'
gate='P37 a declared full command carrying a credential still settles the gate: its masked verification events bind to it (#534 R2)'
for pair in "ledger-api-records-command:$helper" "verification-server:$readback" "directive-retirement:$gate"; do
  file=${pair%%:*}
  title=${pair#*:}
  if ! grep -qF "it('$title'" "test/$file.test.ts"; then
    echo "gc-534 mutation registration guard failed: test/$file.test.ts does not register \"$title\"" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/fast-results.json" test/ledger-api.test.ts test/ledger-api-records-command.test.ts test/directive-retirement.test.ts -t '#534'
fast=$?
npx vitest run --reporter=json --outputFile="$d/heavy-results.json" --config vitest.heavy.config.ts test/verification-server.test.ts -t '#534'
heavy=$?
set -e
echo "gc-534-binding-mutation vitest exits: fast=$fast heavy=$heavy"
if [ "$fast" -eq 0 ] || [ "$heavy" -eq 0 ]; then
  echo "MUTATION SURVIVED: a leg passed with the event binding reduced to strict equality" >&2
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
node "$root/tools/assert-named-red-baseline.mjs" gc-534-mutation "$d/results.json" \
  "$helper" \
  "POST /api/verify $readback" \
  "legacy proven completion without fabricated historical delivery $gate" || exit 2
echo "EXPECTED-NONZERO: the event-binding mutant was killed by the helper pin, the terminal readback and the retirement-gate guard"
exit 1
