#!/bin/sh
# PR130 App-contract before-proof (feature-specific baseline scope).
#
# Runs the FINAL committed App contract test file against an isolated
# archive of the immutable pre-repair integration fe6a774 (contains
# main151; precedes every App repair on this branch). Expected result is
# RED: the semantic-pagination, post-failure-context, and diagnostics
# oracles encode behavior the baseline lacks, so the scope's exit status
# is vitest's own — never masked into a PASS. The archive is retained
# (never deleted) and its location recorded for inspection; dependencies
# are only symlinked, never installed; the lane checkout is never
# mutated. The App tests import src modules directly (no dist leg), so
# no build step is needed here — the RPC prerequisite is kept identical
# to the other declared scopes.
#
# Registration guard: the overlay carries the FINAL suite pin for the App
# file; the guard below re-counts the overlaid registrations with the pin
# guard's own raw-source regex and fails before the vitest leg when the
# overlay is not the registered final test file. The global suite-shape
# pin map is deliberately not selected here: it would compare final pins
# against baseline files whose counts changed for reasons outside this
# repair (main's worktree-freeze files), which is registration noise,
# not App evidence.
set -eu
base=fe6a774efe5b6b77e2a384b8be65ea7e41c437b6
headrev=0c4e129725eb1b8f5af0ee40b14ecdbf5bd33221
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-app.XXXXXX")
git archive "$base" | tar -x -C "$d"
git show "$headrev":test/perkins-github-app.test.ts > "$d/test/perkins-github-app.test.ts"
git show "$headrev":test/suite-shape.test.ts > "$d/test/suite-shape.test.ts"
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s\n' "$d" "$base" "$headrev" > "$prep/app-contract-baseline.last-snapshot.txt"
cd "$d"
expected=$(sed -n "s/.*'perkins-github-app\.test\.ts': \([0-9][0-9]*\).*/\1/p" test/suite-shape.test.ts)
registered=$(grep -oE '\bit\(|\bit\.skipIf\(' test/perkins-github-app.test.ts | wc -l | tr -d ' ')
if [ -z "$expected" ] || [ "$expected" != "$registered" ]; then
  echo "app registration guard failed: pin=${expected:-missing} registered=$registered" >&2
  exit 2
fi
echo "app registration guard ok: $registered registered tests match the final pin"
node tools/patch-vitest-rpc-timeout.mjs
npx vitest run test/perkins-github-app.test.ts
