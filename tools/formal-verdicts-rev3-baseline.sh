#!/bin/sh
# Amendment #3 (j-1717) fail-before proof: the FINAL discriminating admission
# tests run against an isolated git-archive snapshot of the named UNCORRECTED
# head bd58d60518c301b3bcf7443163c3a2048c7508d3 — the revision-2 lineage
# whose shared guard cleared a recorded delivery carrying no publication
# intent and no rebind marker (`recorded-delivery-unresolved` did not exist).
# Expected result is RED by BEHAVIORAL ASSERTION: the Silas digest offered the
# clean-abort row and the authenticated dispatch admission accepted it, so
# the "revision 3" cases fail their refusal assertions there. A pass on
# either leg, a collection/setup/import failure, or a named case that did not
# fail behaviorally breaks the claim (exit 2). The snapshot and the ignored
# pointer file are preserved for inspection; nothing is deleted or checked
# out; no branch/worktree holds the base sha; dependencies are only
# symlinked, never installed; the lane checkout is never mutated.
#
# Registration guard: each overlaid file must be the FINAL registered suite;
# its `it(`/`it.skipIf(` count is compared against the explicit final pin
# before any vitest leg runs, so a stale overlay cannot pass as evidence.
set -eu
base=bd58d60518c301b3bcf7443163c3a2048c7508d3
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts-rev3.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
for f in test/silas-driver.test.ts test/dispatch-server.test.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/formal-verdicts-rev3-baseline.last-snapshot.txt"
cd "$d"
for pair in "silas-driver.test.ts:170" "dispatch-server.test.ts:63"; do
  file=${pair%%:*}
  expected=${pair##*:}
  registered=$(grep -oE '\bit\(|\bit\.skipIf\(' "test/$file" | wc -l | tr -d ' ')
  if [ "$expected" != "$registered" ]; then
    echo "formal-verdicts-rev3 registration guard failed for $file: pin=$expected registered=$registered" >&2
    exit 2
  fi
done
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run test/silas-driver.test.ts -t "revision 3"
a=$?
npx vitest run --config vitest.heavy.config.ts test/dispatch-server.test.ts -t "revision 3"
b=$?
set -e
echo "formal-verdicts-rev3-baseline vitest exits: silas=$a dispatch=$b"
if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: an uncorrected-head leg passed the revision-3 refusals unexpectedly" >&2
  exit 2
fi
echo "EXPECTED-NONZERO: the revision-3 admission refusals failed against the uncorrected head"
exit 1
