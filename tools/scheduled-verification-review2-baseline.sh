#!/bin/sh
# New regressions against the preserved reviewed candidate. Original baseline
# assertion RED and captures remain unchanged and are not replayed for logs.
# Limit (#358): the committed review-2 regressions first appear at 6d49ce70,
# already constructing ClaudeVerificationPermissionChannel, which this
# candidate predates — so the raw-native-corpus regression fails here as a
# setup TypeError and the classifier refuses the run (exit 2). The retained
# review-2 report (classified by the declared gh315-retained-red-classify
# scope) remains the custody artifact; this script never replaces it.
set -e
root="$PWD"
base=e7ed8b4c1c184cbd3cb890c1739fe51f31d9815e
# The regressions are pinned to the revision that authored them (the GH315
# merge), never the evolving working tree: later test files import helpers
# and modules the preserved candidate does not have, which turned every
# rerun into a setup failure the classifier rightly refuses (#358).
regressions=6883628e6ba4f58efb993fb2f042260b84b6a6d1
regression_files="test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts test/claude-adapter.test.ts test/helpers/worker-verification.ts test/helpers/claude-double.mjs test/helpers/verification-native-corpus.mjs test/helpers/verification-native-corpus.d.mts"
# Every pinned revision and file must be in this clone (a shallow checkout
# lacks them) — checked before anything is created.
git cat-file -e "${base}^{commit}" 2>/dev/null || { echo "reviewed candidate $base is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
git cat-file -e "${regressions}^{commit}" 2>/dev/null || { echo "regressions revision $regressions is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
for f in $regression_files; do
  git cat-file -e "${regressions}:$f" 2>/dev/null || { echo "pinned regression file $f is missing at $regressions" >&2; exit 2; }
done
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-review2-baseline.XXXXXX")
git archive "$base" | tar -x -C "$d"
for f in $regression_files; do
  git show "${regressions}:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf 'GH315 reviewed-candidate source=%s regressions=%s head=%s snapshot=%s\n' "$base" "$regressions" "$(git rev-parse HEAD)" "$d"
node "$root/tools/prepare-scheduled-verification-review2-fixture.mjs" "$d"
cd "$d"
npm run build
# #358: the status regression's helper must exist in the built snapshot — a
# missing helper would render exactly like the action's own rejection.
test -f dist/verify/capture-cli.js || { echo "the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing" >&2; exit 2; }
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/fast-results.json" test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts -t 'review-2'
a=$?
npx vitest run --reporter=json --outputFile="$d/heavy-results.json" --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-2'
b=$?
printf 'GH315 reviewed-candidate fast=%s heavy=%s; expected assertion RED, inspect retained output\n' "$a" "$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then echo 'NOT BEHAVIORAL RED: passing candidate leg'; exit 2; fi
node "$root/tools/classify-scheduled-verification-red.mjs" 2 "$d/fast-results.json" "$d/heavy-results.json" || exit 2
exit 1
