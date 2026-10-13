#!/bin/sh
# E9 delivery/terminal regressions on the exact retained pre-fix source.
# Authenticated scheduler owns every producer; actual named assertions decide RED.
set -eu
base=b868ad432cfce675ad2768ff1ad8053943e66856
root="$PWD"
prep=_bmad-output/gate-prep/gh315-e9-red
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-e9-red.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm "$d/base.tar"
cp test/claude-adapter.test.ts "$d/test/claude-adapter.test.ts"
ln -s "$root/node_modules" "$d/node_modules"
printf 'base=%s\nhead=%s\ndir=%s\n' "$base" "$(git rev-parse HEAD)" "$d" > "$prep/snapshot.txt"
cd "$d"
npm run build
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-4 initialization' --reporter=json --outputFile="$d/results.json"
status=$?
set -e
printf 'E9 retained baseline vitest exit=%s; report=%s/results.json\n' "$status" "$d"
if [ "$status" -eq 0 ]; then
  echo 'FAILS-BEFORE CLAIM BROKEN: initialization regressions passed before repair'
  exit 3
fi
exit "$status"
