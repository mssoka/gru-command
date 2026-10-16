#!/bin/sh
# Native R6 fail-before proof: the FINAL real-GhPrPoster restart/admission
# regression runs against an isolated git-archive snapshot of the authentic
# uncorrected Bdc head. Its fake provider commits the APPROVE review as B after
# identity A was prepared, loses the response, then exposes that exact frozen
# head/body record as DISMISSED to an A restart. Bdc returns absence there;
# the named no-absence assertion must fail behaviorally. The immutable source
# is never overlaid or checked out: only the exact final dispatch-server test
# is overlaid. A passing named case, missing registration, or setup/import
# failure is classified as a broken fails-before claim (exit 2). The archive,
# pointer and classifier output are retained; dependencies are symlinked and
# no install, live provider write, branch mutation or checkout occurs.
set -eu
base=bdc16290dfe85cac81234d76fef002ad8ee1faa1
headrev=$(git rev-parse HEAD)
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-formal-verdicts-r6.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm -f "$d/base.tar"
for f in test/dispatch-server.test.ts; do
  mkdir -p "$d/$(dirname "$f")"
  git show "$headrev:$f" > "$d/$f"
done
ln -s "$root/node_modules" "$d/node_modules"
baseSourceBlob=$(git rev-parse "$base:src/dispatch/perkins.ts")
finalTestBlob=$(git rev-parse "$headrev:test/dispatch-server.test.ts")
printf '%s base=%s sourceBlob=%s head=%s finalTestBlob=%s\n' "$d" "$base" "$baseSourceBlob" "$headrev" "$finalTestBlob" > "$prep/formal-verdicts-r6-baseline.last-snapshot.txt"
cd "$d"
registered=$(grep -oE '\bit\(|\bit\.skipIf\(' test/dispatch-server.test.ts | wc -l | tr -d ' ')
if [ "$registered" != 70 ]; then
  echo "formal-verdicts-r6 registration guard failed for dispatch-server.test.ts: pin=70 registered=$registered" >&2
  exit 2
fi
node tools/patch-vitest-rpc-timeout.mjs
set +e
npx vitest run --reporter=json --outputFile="$d/dispatch-results.json" --config vitest.heavy.config.ts test/dispatch-server.test.ts -t "native R6 F1"
a=$?
set -e
echo "formal-verdicts-r6-baseline vitest exit: dispatch-server=$a"
if [ "$a" -eq 0 ]; then
  echo "FAILS-BEFORE CLAIM BROKEN: the uncorrected Bdc head passed the native R6 regression unexpectedly" >&2
  exit 2
fi
node "$root/tools/assert-named-red-baseline.mjs" dispatch-server "$d/dispatch-results.json" \
  "dispatch server (E8) keeps a foreign DISMISSED review unresolved through real recovery, digest, and dispatch admission (native R6 F1)" || exit 2
echo "EXPECTED-NONZERO: the native R6 foreign submitted-state false-absence regression failed behaviorally against authentic Bdc"
exit 1
