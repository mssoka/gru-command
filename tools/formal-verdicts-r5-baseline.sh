#!/bin/sh
# Native R5 fail-before proof: the FINAL whole-review regression suite runs
# against an isolated git-archive snapshot of the named UNCORRECTED head
# 4014ca0368735d800fbb1d86a1b557ed17b89bc4 — where an App review entry with
# its body omitted still passed the decidable-record gate (so a covered walk
# read a hidden publication as absence), and a gh review carrying the exact
# frozen head, published body and required state under a DIFFERENT account
# was filtered out of both credit and wrong-state evidence (so a rotated
# credential's committed review was read as absence). Expected result is RED
# by BEHAVIORAL ASSERTION on both named cases (each recorded the false
# absence certificate there). A pass on a named case, a missing named case,
# an import/collection/setup failure, or a named case that did not fail as
# an assertion is classified by tools/assert-named-red-baseline.mjs and
# exits 2. The snapshot and the ignored pointer file are preserved for
# inspection; nothing is deleted or checked out; dependencies are only
# symlinked, never installed; the lane checkout is never mutated.
set -eu
base=4014ca0368735d800fbb1d86a1b557ed17b89bc4
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts-r5.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
for f in test/perkins-builtin-wave.test.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/formal-verdicts-r5-baseline.last-snapshot.txt"
cd "$d"
for pair in "perkins-builtin-wave.test.ts:245"; do
  file=${pair%%:*}
  expected=${pair##*:}
  registered=$(grep -oE '\bit\(|\bit\.skipIf\(' "test/$file" | wc -l | tr -d ' ')
  if [ "$expected" != "$registered" ]; then
    echo "formal-verdicts-r5 registration guard failed for $file: pin=$expected registered=$registered" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/wave-results.json" --config vitest.heavy.config.ts test/perkins-builtin-wave.test.ts -t "native R5"
a=$?
set -e
echo "formal-verdicts-r5-baseline vitest exits: wave=$a"
if [ "$a" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: the uncorrected-head leg passed the native R5 regressions unexpectedly" >&2
  exit 2
fi
node "$root/tools/assert-named-red-baseline.mjs" wave "$d/wave-results.json" \
  "formal GitHub publication durability and restart reconciliation keeps a foreign-actor review that enacted the required state from being read as absence (native R5 F2)" \
  "formal GitHub publication durability and restart reconciliation keeps an interrupted App publication unresolved when the provider omits the review body (native R5 F1)" || exit 2
echo "EXPECTED-NONZERO: the native R5 omitted-body and foreign-actor absence regressions failed behaviorally against the uncorrected head"
exit 1
