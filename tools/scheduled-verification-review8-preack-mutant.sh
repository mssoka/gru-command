#!/bin/sh
# Demonstrate the new pre-ACK regression catches ordinary Bash approval.
# Mutate only an isolated archive: product initialization gating stays intact.
set -eu
base=f62d8f1c3a861df267e360842f16fc8aa4a34687
root="$PWD"
mkdir -p _bmad-output/gate-prep
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-r8-preack-mutant.XXXXXX")
git archive "$base" -o "$d/base.tar"
tar -xf "$d/base.tar" -C "$d"
rm "$d/base.tar"
cp test/claude-adapter.test.ts "$d/test/claude-adapter.test.ts"
ln -s "$root/node_modules" "$d/node_modules"
# One deliberate mutant removes ACK gating; no shipped source is changed.
node --input-type=module - "$d/src/runtime/claude-verification-settings.ts" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const source = readFileSync(file, 'utf8');
const before = 'const valid = this.initialized && !this.closed &&';
if (source.split(before).length !== 2) throw new Error('Require one original initialization gate in isolated archive');
writeFileSync(file, source.replace(before, 'const valid = !this.closed &&'));
JS
printf 'R8 pre-ACK mutant base=%s receiving-head=%s reports=%s\n' "$base" "$(git rev-parse HEAD)" "$d"
cd "$d"
node tools/patch-vitest-rpc-timeout.mjs
npm run build
set +e
npx vitest run --config vitest.heavy.config.ts test/claude-adapter.test.ts -t 'review-8 ordinary pre-ACK Bash' --reporter=json --outputFile="$d/results.json"
status=$?
set -e
printf 'R8 pre-ACK mutant actual runner exit=%s report=%s/results.json\n' "$status" "$d"
if [ "$status" -eq 0 ]; then
  echo 'FAILS-BEFORE CLAIM BROKEN: ordinary pre-ACK approval escaped the new regression'
  exit 3
fi
exit "$status"
