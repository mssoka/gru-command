#!/bin/sh
# Native R3 fail-before proof: the FINAL lookup-identity regression suite
# runs against an isolated git-archive snapshot of the named UNCORRECTED head
# 1f7050317e63690e2fc77e1dec55331a5a30f7ac — where restart absence compared
# the prepared identity against a SEPARATE authenticatedActor probe run AFTER
# reconciliation, so a lookup as B (filtering A's surviving review away)
# followed by a credential return to A before the probe recorded a FALSE
# absence. Expected result is RED by BEHAVIORAL ASSERTION on both legs (the
# absence certificate was false there). A pass on either leg, a missing named
# case, an import/collection/setup failure, or a named case that did not fail
# as an assertion is classified by tools/assert-named-red-baseline.mjs and
# exits 2. The snapshot and the ignored pointer file are preserved for
# inspection; nothing is deleted or checked out; dependencies are only
# symlinked, never installed; the lane checkout is never mutated.
set -eu
base=1f7050317e63690e2fc77e1dec55331a5a30f7ac
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts-r3.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
for f in test/perkins-builtin-wave.test.ts test/silas-driver.test.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/formal-verdicts-r3-baseline.last-snapshot.txt"
cd "$d"
for pair in "perkins-builtin-wave.test.ts:229" "silas-driver.test.ts:172"; do
  file=${pair%%:*}
  expected=${pair##*:}
  registered=$(grep -oE '\bit\(|\bit\.skipIf\(' "test/$file" | wc -l | tr -d ' ')
  if [ "$expected" != "$registered" ]; then
    echo "formal-verdicts-r3 registration guard failed for $file: pin=$expected registered=$registered" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/wave-results.json" --config vitest.heavy.config.ts test/perkins-builtin-wave.test.ts -t "native R3"
a=$?
npx vitest run --reporter=json --outputFile="$d/silas-results.json" test/silas-driver.test.ts -t "native R3"
b=$?
set -e
echo "formal-verdicts-r3-baseline vitest exits: wave=$a silas=$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: an uncorrected-head leg passed the native R3 regression unexpectedly" >&2
  exit 2
fi
node "$root/tools/assert-named-red-baseline.mjs" wave "$d/wave-results.json" \
  "formal GitHub publication durability and restart reconciliation binds restart absence to the identity the lookup actually used (native R3)" || exit 2
node "$root/tools/assert-named-red-baseline.mjs" silas "$d/silas-results.json" \
  "silas digest (the four actionable states) does not offer a clean-abort re-arm after a real-poster recovery whose lookup ran as a different account (native R3)" || exit 2
echo "EXPECTED-NONZERO: the native R3 lookup-identity regressions failed behaviorally against the uncorrected head"
exit 1
