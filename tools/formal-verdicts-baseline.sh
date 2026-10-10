#!/bin/sh
# Formal GitHub verdicts fail-before proof (job
# perkins-github-formal-verdicts-20261010; owner ruling j-1615).
#
# Runs the FINAL committed behavioral suites (the two files that carry the
# formal-event regressions) against an isolated git-archive snapshot of the
# recorded pre-change base d0e6389 — the COMMENT-only publisher that sends
# `event: "COMMENT"` and enforces `COMMENTED`. Expected result is RED by
# BEHAVIORAL ASSERTION: the named regressions assert that an eligible native
# judgment publishes a real APPROVED/CHANGES_REQUESTED event and that a
# wrong-state receipt is refused, none of which the base can do. The vitest
# exits are echoed intact; a pass on either leg, a collection/setup/import
# failure, or a named regression that did not fail as an AssertionError is
# classified by tools/assert-formal-verdicts-baseline.mjs and exits 2. The
# snapshot directory and the ignored pointer file are preserved for
# inspection; nothing is deleted or checked out; no branch/worktree holds
# the base sha; dependencies are only symlinked, never installed; the lane
# checkout is never mutated.
#
# Registration guard: both overlaid files must be the FINAL registered
# suites — the overlay counts are re-counted with the suite-pin guard's own
# raw-source regex and compared against the final pins in the overlaid
# test/suite-shape.test.ts before any vitest leg runs, so a stale overlay
# cannot pass as evidence.
set -eu
base=d0e638936b5b4afb000a1920a126dfa2125666de
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
# The new standalone evidence module is added to the overlay because the
# FINAL test files import it. It is purely additive: the base implementation
# never references it, its only imports are type-only (erased at runtime),
# and it changes nothing about the old publisher behavior the regressions
# measure. The remaining overlay is the FINAL test suites only.
for f in test/perkins-github-app.test.ts test/perkins-builtin-wave.test.ts test/suite-shape.test.ts src/dispatch/publication-evidence.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/formal-verdicts-baseline.last-snapshot.txt"
cd "$d"
for pair in perkins-github-app.test.ts perkins-builtin-wave.test.ts; do
  expected=$(sed -n "s/.*'$pair': \([0-9][0-9]*\).*/\1/p" test/suite-shape.test.ts)
  registered=$(grep -oE '\bit\(|\bit\.skipIf\(' "test/$pair" | wc -l | tr -d ' ')
  if [ -z "$expected" ] || [ "$expected" != "$registered" ]; then
    echo "formal-verdicts registration guard failed for $pair: pin=${expected:-missing} registered=$registered" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/app-results.json" test/perkins-github-app.test.ts -t "formal GitHub"
a=$?
npx vitest run --reporter=json --outputFile="$d/wave-results.json" --config vitest.heavy.config.ts test/perkins-builtin-wave.test.ts -t "formal GitHub"
b=$?
set -e
echo "formal-verdicts-baseline vitest exits: app=$a wave=$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: a baseline leg passed the formal-event regressions unexpectedly" >&2
  exit 2
fi
node "$root/tools/assert-formal-verdicts-baseline.mjs" "$d/app-results.json" "$d/wave-results.json" || exit 2
echo "EXPECTED-NONZERO: both legs failed the formal-event behavioral assertions against the COMMENT-only base"
exit 1
