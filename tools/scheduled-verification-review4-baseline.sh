#!/bin/sh
# New review-4 cases only, against the retained exact pre-repair receiving head.
# The scheduler owns execution. Preserve the original runner status/report;
# parent grades actual named assertion failures, never arbitrary nonzero exits.
set -eu
base=0b26e348708dfe99003e03139664d9f52a239148
root="$PWD"
prep=_bmad-output/gate-prep/gh315-review4-red
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-review4-red.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm "$d/base.tar"
cp test/worker-verification-policy.test.ts "$d/test/worker-verification-policy.test.ts"
ln -s "$root/node_modules" "$d/node_modules"
printf 'base=%s\nhead=%s\ndir=%s\n' "$base" "$(git rev-parse HEAD)" "$d" > "$prep/snapshot.txt"
cd "$d"
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run test/worker-verification-policy.test.ts -t 'review-4 (npm boolean|Vite clearScreen)' --reporter=json --outputFile="$d/results.json"
status=$?
set -e
printf 'review4 retained baseline vitest exit=%s; report=%s/results.json\n' "$status" "$d"
if [ "$status" -eq 0 ]; then
  echo 'FAILS-BEFORE CLAIM BROKEN: both normalization regressions passed before repair'
  exit 3
fi
exit "$status"
