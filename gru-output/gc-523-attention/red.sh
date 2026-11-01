#!/bin/sh
# gc-523-attention-red (#523): the fail-before tests A1-A6 of
# test/directive-recovery-attention.test.ts, run against the dispatch base's
# source in a scratch `git archive` extract with the candidate's test file
# copied in. Run from the lane root, normally as the scheduled scope.
#
# Exit codes: 1 is vitest's red, the expected result (only A1-A6 run, so the
# verbose reporter lists exactly those six as failed); 2 is a failed setup (the
# base extract, the test copy, the dependency link or the vitest patch), which
# is NOT the expected red. The extract is removed on every exit.
root=$PWD
base=ccd6337fb629f3fc69bea725d06873733b363182

d=$(mktemp -d "${TMPDIR:-/tmp}/gru-523-attention-red.XXXXXX") || exit 2
cleanup() { cd "$root" && rm -rf -- "$d"; }
trap cleanup EXIT
trap 'exit 143' TERM INT HUP
abs=$(cd "$d" && pwd -P) || exit 2
d=$abs

{
  git archive "$base" | tar -x -C "$d" &&
    test -f "$d/package.json" &&
    cp test/directive-recovery-attention.test.ts "$d/test/directive-recovery-attention.test.ts" &&
    test -x "$root/node_modules/.bin/vitest" &&
    ln -s "$root/node_modules" "$d/node_modules"
} || {
  echo "gc-523-attention RED setup failed (base extract, test copy or dependency link): this is not the expected red" >&2
  exit 2
}

printf 'gc-523-attention RED base=%s candidate=%s snapshot=%s\n' "$base" "$(git rev-parse HEAD)" "$d"
cd "$d" || exit 2
node tools/patch-vitest-rpc-timeout.mjs || {
  echo "gc-523-attention RED setup failed (vitest patch): this is not the expected red" >&2
  exit 2
}
npx vitest run test/directive-recovery-attention.test.ts -t 'A[1-6]\. ' --reporter=verbose
code=$?
exit "$code"
