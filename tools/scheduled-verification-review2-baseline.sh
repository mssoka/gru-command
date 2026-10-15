#!/bin/sh
# New regressions against the preserved reviewed candidate. Original baseline
# assertion RED and captures remain unchanged and are not replayed for logs.
set -e
root="$PWD"
base=e7ed8b4c1c184cbd3cb890c1739fe51f31d9815e
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-review2-baseline.XXXXXX")
git archive "$base" | tar -x -C "$d"
cp test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts test/claude-adapter.test.ts "$d/test/"
cp test/helpers/worker-verification.ts test/helpers/claude-double.mjs test/helpers/verification-native-corpus.mjs test/helpers/verification-native-corpus.d.mts "$d/test/helpers/"
ln -s "$root/node_modules" "$d/node_modules"
printf 'GH315 reviewed-candidate source=%s head=%s snapshot=%s\n' "$base" "$(git rev-parse HEAD)" "$d"
node "$root/tools/prepare-scheduled-verification-review2-fixture.mjs" "$d"
cd "$d"
npm run build
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
