#!/bin/sh
# New R8 cases only. Execute under authenticated declared-scope admission.
# Keep both runner statuses and immutable JSON reports, including assertion RED.
set -eu
root="$PWD"
mkdir -p _bmad-output/gate-prep
d=$(mktemp -d "$root/_bmad-output/gate-prep/gh315-review8.XXXXXX")
printf 'R8 current source head=%s reports=%s\n' "$(git rev-parse HEAD)" "$d"
node tools/patch-vitest-rpc-timeout.mjs
npm run build
set +e
npx vitest run test/worker-verification-policy.test.ts test/pi-adapter.test.ts -t 'review-8' --reporter=json --outputFile="$d/fast-results.json"
a=$?
npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-8' --reporter=json --outputFile="$d/heavy-results.json"
b=$?
set -e
printf 'R8 actual runner exits fast=%s heavy=%s; reports=%s\n' "$a" "$b" "$d"
# A nonzero status is NOT classified as behavioral RED by this runner.
# The named assertion records, setup status and underlying trigger must be read.
if [ "$a" -ne 0 ] || [ "$b" -ne 0 ]; then exit 1; fi
