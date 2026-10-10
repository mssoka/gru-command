#!/bin/sh
# Native R2 (F1/F2/F3) fail-before proof: the FINAL recovery/absence
# regression suite runs against an isolated git-archive snapshot of the
# named UNCORRECTED head 89f3a7189da3ac82842802015d79b2d8f7f7af0e — whose
# restart reconciliation trusted unverified publication bytes, had no bound
# posting identity, and accepted an undecidable gh review list as absence.
# Expected result is RED by BEHAVIORAL ASSERTION on the discriminating legs
# (the digest/absence certificates were false there). The final additive
# `publication-evidence.ts` rides the overlay because the final tests import
# the new prepared-identity constants; it changes nothing else (type-only
# imports at runtime, the base implementation never reads it). A pass on
# either leg, a missing named case, an import/collection/setup failure, or a
# named case that did not fail as an assertion is classified by
# tools/assert-named-red-baseline.mjs and exits 2. The snapshot and the
# ignored pointer file are preserved for inspection; nothing is deleted or
# checked out; dependencies are only symlinked, never installed; the lane
# checkout is never mutated.
set -eu
base=89f3a7189da3ac82842802015d79b2d8f7f7af0e
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts-r2.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
for f in test/perkins-builtin-wave.test.ts test/silas-driver.test.ts src/dispatch/publication-evidence.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/formal-verdicts-r2-baseline.last-snapshot.txt"
cd "$d"
for pair in "perkins-builtin-wave.test.ts:222" "silas-driver.test.ts:171"; do
  file=${pair%%:*}
  expected=${pair##*:}
  registered=$(grep -oE '\bit\(|\bit\.skipIf\(' "test/$file" | wc -l | tr -d ' ')
  if [ "$expected" != "$registered" ]; then
    echo "formal-verdicts-r2 registration guard failed for $file: pin=$expected registered=$registered" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/wave-results.json" --config vitest.heavy.config.ts test/perkins-builtin-wave.test.ts -t "native R2"
a=$?
npx vitest run --reporter=json --outputFile="$d/silas-results.json" test/silas-driver.test.ts -t "native R2"
b=$?
set -e
echo "formal-verdicts-r2-baseline vitest exits: wave=$a silas=$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: an uncorrected-head leg passed the native R2 regressions unexpectedly" >&2
  exit 2
fi
node "$root/tools/assert-named-red-baseline.mjs" wave "$d/wave-results.json" \
  "formal GitHub publication durability and restart reconciliation never certifies absence when the canonical publication bytes changed after the intent (native R2 F1)" \
  "formal GitHub publication durability and restart reconciliation requires provable posting-identity continuity before certifying absence (native R2 F2)" \
  "formal GitHub publication durability and restart reconciliation holds a restart whose gh lookup met an undecidable review list (native R2 F3)" \
  "GitHub SHA-bound Perkins delivery refuses an undecidable gh review list instead of reporting absence (native R2 F3)" || exit 2
node "$root/tools/assert-named-red-baseline.mjs" silas "$d/silas-results.json" \
  "silas digest (the four actionable states) does not offer a clean-abort re-arm after a held recovery whose absence certificate would have been false (native R2 F1/F2)" || exit 2
echo "EXPECTED-NONZERO: the native R2 false-absence regressions failed behaviorally against the uncorrected head"
exit 1
