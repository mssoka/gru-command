#!/bin/sh
# New regressions against the preserved reviewed candidate. Original baseline
# assertion RED and captures remain unchanged and are not replayed for logs.
set -e
root="$PWD"
base=2823cf75e4a736bd9548973294e1f569fceab718
# Every pinned revision must be in this clone (a shallow checkout lacks them).
git cat-file -e "${base}^{commit}" 2>/dev/null || { echo "reviewed candidate $base is not in this clone — fetch full history (git fetch --unshallow)" >&2; exit 2; }
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-review-baseline.XXXXXX")
git archive "$base" | tar -x -C "$d"
# The regressions are pinned to the revision that authored them (the GH315
# merge), never the evolving working tree: later test files import helpers
# and modules the preserved candidate does not have, which turned every
# rerun into a setup failure the classifier rightly refuses (#358).
regressions=6883628e6ba4f58efb993fb2f042260b84b6a6d1
for f in test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts test/claude-adapter.test.ts \
  test/helpers/worker-verification.ts test/helpers/claude-double.mjs test/helpers/verification-native-corpus.mjs test/helpers/verification-native-corpus.d.mts; do
  git cat-file -e "${regressions}:$f" 2>/dev/null || { echo "pinned regression file $f is missing at $regressions — fetch full history (git fetch --unshallow)" >&2; exit 2; }
  git show "${regressions}:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf 'GH315 reviewed-candidate source=%s regressions=%s head=%s snapshot=%s\n' "$base" "$regressions" "$(git rev-parse HEAD)" "$d"
cd "$d"
npm run build
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/fast-results.json" test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts -t 'review-1'
a=$?
npx vitest run --reporter=json --outputFile="$d/heavy-results.json" --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-1'
b=$?
printf 'GH315 reviewed-candidate fast=%s heavy=%s; expected assertion RED, inspect retained output\n' "$a" "$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then echo 'NOT BEHAVIORAL RED: passing candidate leg'; exit 2; fi
node "$root/tools/classify-scheduled-verification-red.mjs" 1 "$d/fast-results.json" "$d/heavy-results.json" || exit 2
exit 1
