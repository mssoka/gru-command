#!/bin/sh
# PR130 App-contract before-proof (feature-specific baseline scope).
#
# Runs a COMMITTED App contract test file against an isolated archive of the
# immutable pre-repair integration fe6a774 (contains main151; precedes every
# App repair on this branch). Expected result is RED for oracles the baseline
# lacks, so the scope's exit status is vitest's own — never masked into a
# PASS. The archive is retained (never deleted) and its location recorded
# for inspection; dependencies are only symlinked, never installed; the lane
# checkout is never mutated. The App tests import src modules directly (no
# dist leg), so no build step is needed here — the RPC prerequisite is kept
# identical to the other declared scopes.
#
# Evidence scope (#190). The overlay revision is explicit and checked:
#   - Default (CURRENT contract): the overlay is the App test file and its
#     matching suite pin from the checkout's committed HEAD. The scope check
#     fails when the exercised test file or its pin differs from the
#     checkout's own copies (stale pin, uncommitted edit), so a
#     passing/expected-red run speaks for every current oracle.
#   - APP_BASELINE_HEADREV=<rev> (HISTORICAL SUBSET): the overlay comes from
#     that older revision. The run is loudly labelled as a historical subset
#     whose result says nothing about oracles added after <rev>; the check
#     still fails if that revision's own pin disagrees with its test file.
# `--scope-only` runs the scope check and stops before the vitest leg (used
# by the deterministic scope test); it never masks a failure.
#
# Registration guard: the overlay's suite pin for the App file is re-counted
# with the pin guard's own raw-source regex and must equal the registrations
# of the exercised file. The global suite-shape pin map is deliberately not
# selected here: it would compare final pins against baseline files whose
# counts changed for reasons outside this repair, which is registration
# noise, not App evidence.
set -eu
scope_only=0
if [ "${1:-}" = "--scope-only" ]; then scope_only=1; fi
base=fe6a774efe5b6b77e2a384b8be65ea7e41c437b6
current=$(git rev-parse --verify HEAD^{commit})
headrev=${APP_BASELINE_HEADREV:-$current}
headrev=$(git rev-parse --verify "$headrev^{commit}")
if [ "$headrev" = "$current" ]; then
  scope=current
else
  scope=historical
fi
root=$(pwd)
prep=_bmad-output/gate-prep
mkdir -p "$prep"
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-baseline-app.XXXXXX")
git archive "$base" | tar -x -C "$d"
git show "$headrev":test/perkins-github-app.test.ts > "$d/test/perkins-github-app.test.ts"
git show "$headrev":test/suite-shape.test.ts > "$d/test/suite-shape.test.ts"
ln -s "$root/node_modules" "$d/node_modules"
printf '%s base=%s head=%s scope=%s\n' "$d" "$base" "$headrev" "$scope" > "$prep/app-contract-baseline.last-snapshot.txt"
if [ "$scope" = "historical" ]; then
  echo "app baseline scope: HISTORICAL SUBSET from $headrev — says nothing about App oracles added after it (current HEAD is $current)"
fi
cd "$d"
expected=$(sed -n "s/.*'perkins-github-app\.test\.ts': \([0-9][0-9]*\).*/\1/p" test/suite-shape.test.ts)
registered=$(grep -oE '\bit\(|\bit\.skipIf\(' test/perkins-github-app.test.ts | wc -l | tr -d ' ')
if [ -z "$expected" ] || [ "$expected" != "$registered" ]; then
  echo "app registration guard failed: pin=${expected:-missing} registered=$registered" >&2
  exit 2
fi
if [ "$scope" = "current" ]; then
  # The exercised file and its pin must be byte-identical to the checkout's
  # own current ones: a stale or divergent overlay cannot be claimed as the
  # current contract.
  for f in test/perkins-github-app.test.ts test/suite-shape.test.ts; do
    if ! cmp -s "$root/$f" "$f"; then
      echo "app scope check failed: $f differs from the checkout's current contract at $current (use APP_BASELINE_HEADREV for a labelled historical subset)" >&2
      exit 3
    fi
  done
  echo "app registration guard ok: $registered registered tests match the current pin ($current)"
else
  echo "app registration guard ok: $registered registered tests match the pin at $headrev (historical subset)"
fi
if [ "$scope_only" -eq 1 ]; then exit 0; fi
node tools/patch-vitest-rpc-timeout.mjs
npx vitest run test/perkins-github-app.test.ts
