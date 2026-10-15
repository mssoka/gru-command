#!/bin/sh
# Preserve assertion RED on unguarded source for both ordinary runtimes.
set -e;
root="$PWD";
base=12142cf2f051270570af81a2fb9668a995fa73ec;
d=$(mktemp -d "${TMPDIR:-/tmp}/gru-gh315-baseline.XXXXXX");
git archive "$base" | tar -x -C "$d";
cp test/pi-adapter.test.ts test/claude-adapter.test.ts "$d/test/";
cp test/helpers/worker-verification.ts test/helpers/claude-double.mjs test/helpers/verification-native-corpus.mjs "$d/test/helpers/";
ln -s "$root/node_modules" "$d/node_modules";
printf "GH315 baseline source=%s head=%s snapshot=%s\\n" "$base" "$(git rev-parse HEAD)" "$d";
cd "$d";
npm run build;
node tools/patch-vitest-rpc-timeout.mjs;
set +e;
npx vitest run --reporter=json --outputFile="$d/pi-results.json" test/pi-adapter.test.ts -t "scheduled verification guard";
a=$?;
npx vitest run --reporter=json --outputFile="$d/claude-results.json" --config vitest.heavy.config.ts test/claude-adapter.test.ts -t "scheduled verification guard";
b=$?;
printf "GH315 baseline Pi=%s Claude=%s\\n" "$a" "$b";
node "$root/tools/assert-scheduled-verification-baseline.mjs" "$d/pi-results.json" "$d/claude-results.json" || exit 2
if [ "$a" -ne 0 ] && [ "$b" -ne 0 ]; then exit 1; fi
exit 2
