#!/bin/sh
# New regressions against the preserved reviewed candidate. Original baseline
# assertion RED and captures remain unchanged and are not replayed for logs.
set -e
root="$PWD"
base=2823cf75e4a736bd9548973294e1f569fceab718
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-review-baseline.XXXXXX")
git archive "$base" | tar -x -C "$d"
cp test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts test/claude-adapter.test.ts "$d/test/"
cp test/helpers/worker-verification.ts test/helpers/claude-double.mjs test/helpers/verification-native-corpus.mjs test/helpers/verification-native-corpus.d.mts "$d/test/helpers/"
ln -s "$root/node_modules" "$d/node_modules"
printf 'GH315 reviewed-candidate source=%s head=%s snapshot=%s\n' "$base" "$(git rev-parse HEAD)" "$d"
cd "$d"
npm run build
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts -t 'review-1'
a=$?
npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-1'
b=$?
printf 'GH315 reviewed-candidate fast=%s heavy=%s; expected assertion RED, inspect retained output\n' "$a" "$b"
if [ "$a" -ne 0 ] || [ "$b" -ne 0 ]; then exit 1; fi
