#!/bin/sh
# R8 regressions or the unchanged full component selection, with JSON evidence.
# Execute under authenticated declared-scope admission; never a local FULL.
# Keep both runner statuses and immutable JSON reports, including assertion RED.
set -eu
root="$PWD"
mkdir -p _bmad-output/gate-prep
d=$(mktemp -d "$root/_bmad-output/gate-prep/gh315-review8.XXXXXX")
printf 'R8 current source head=%s reports=%s\n' "$(git rev-parse HEAD)" "$d"
node tools/patch-vitest-rpc-timeout.mjs
npm run build
if [ "${1:-all}" = version ]; then
  # Newly discovered selected-verb defect only; do not replay the five prior REDs.
  exec npx vitest run test/worker-verification-policy.test.ts -t 'review-8 selected Vitest run' --reporter=json --outputFile="$d/version-results.json"
fi
set +e
if [ "${1:-all}" = focused ]; then
  # Same files/phases as scheduled-verification-focused, without a title filter.
  npx vitest run test/classify-scheduled-verification-red.test.ts test/worker-verification-policy.test.ts test/workflow-session.test.ts test/pi-adapter.test.ts test/verification-capture.test.ts test/verification-scheduler.test.ts test/verification-evidence.test.ts test/suite-shape.test.ts --reporter=json --outputFile="$d/fast-results.json"
  a=$?
  npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts test/verification-server.test.ts --reporter=json --outputFile="$d/heavy-results.json"
  b=$?
else
  npx vitest run test/worker-verification-policy.test.ts test/pi-adapter.test.ts -t 'review-8' --reporter=json --outputFile="$d/fast-results.json"
  a=$?
  npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-8' --reporter=json --outputFile="$d/heavy-results.json"
  b=$?
fi
set -e
printf 'R8 actual runner exits fast=%s heavy=%s; reports=%s\n' "$a" "$b" "$d"
# A nonzero status is NOT classified as behavioral RED by this runner.
# The named assertion records, setup status and underlying trigger must be read.
if [ "$a" -ne 0 ] || [ "$b" -ne 0 ]; then exit 1; fi
