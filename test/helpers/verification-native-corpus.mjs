// Independently authored raw permission corpus: no production parser imports.
// subjects are the explicitly expected executable segments handed to native
// pattern matching. Raw input is retained, including quotes and read data.
export const nativeCorpus = [
  { raw: 'cd web && npx vitest run --config vitest.config.ts src/lib/board-client.test.ts src/ui/board.test.ts', refused: true, subjects: ['cd web', 'npx vitest run --config vitest.config.ts src/lib/board-client.test.ts src/ui/board.test.ts'] },
  { raw: 'npm test', refused: true, subjects: ['npm test'] },
  { raw: 'npm run lint && npm run typecheck && npm run build && npm run build:web', refused: true, subjects: ['npm run lint', 'npm run typecheck', 'npm run build', 'npm run build:web'] },
  ...['npm tst', 'npm t', 'npm run-script lint', 'npm rum lint', 'npm urn lint', 'npm exec -- vitest run', 'npm x -- vitest run', 'npm --loglevel error test', 'npm run --if-present lint', 'npm --loglevel error run --if-present lint', './web/node_modules/.bin/vitest run', 'web/node_modules/.bin/vitest run', 'npm test>test.log'].map((raw) => ({ raw, refused: true, subjects: [raw] })),
  { raw: 'cd web && ../node_modules/.bin/vitest run', refused: true, subjects: ['cd web', '../node_modules/.bin/vitest run'] },
  { raw: 'CI=1 npm run quality', refused: true, subjects: ['npm run quality'] },
  ...['env -i PATH="$PATH" npm test', 'env -u UNUSED command -p env --ignore-environment PATH="$PATH" npm test', 'command -- env --unset=UNUSED npm test'].map((raw) => ({ raw, refused: true, subjects: ['npm test'] })),
  { raw: "cat <<'EOF'\nnpm test\nEOF\nnpm run build:web", refused: true, subjects: ['cat', 'npm run build:web'] },
  { raw: "npm test; cat <<'EOF'\nnpx vitest run\nEOF", refused: true, subjects: ['npm test', 'cat'] },
  ...['! printf ok | npm test', '( npm test )', '{ npm test; }'].map((raw) => ({ raw, refused: true, subjects: ['npm test'] })),
  { raw: '! npm test' , refused: true, subjects: ['npm test'] },
  { raw: 'if npm test; then printf ok; fi', refused: true, subjects: ['npm test', 'printf ok'] },
  { raw: 'env -i PATH="$PATH" command -p npm test', refused: true, subjects: ['npm test'] },
  ...['npm view test', "command printf '%s' 'npm test example'", "printf '%s' 'X=1 npm test -- --help'", 'tsc --version', 'tsc --showConfig', 'eslint --help', 'npx --no-install tsc --version', 'npm exec -- tsc --showConfig', 'npx --no-install eslint --help', "cat <<'EOF'\nnpm test\nEOF", 'cat <<EOF\nnpm test\nnpx vitest run\nEOF'].map((raw) => ({ raw, refused: false, subjects: [raw] })),
];

// Strict-repair raw cases. Expected dispositions do not use production lexing.
nativeCorpus.push(
  ...['jest foo.test.js', 'tsc src/index.ts', 'eslint src/file.ts', 'eslint', 'playwright test', 'npx playwright test',
    'npm --workspace app test', 'npm -w app test', 'npm --silent test', 'npx --yes vitest run',
    'npm "te\\\nst"', 'printf \'%s\' "$( # comment )\nnpm test\n)"',
    '>| /dev/null npm test', 'npm >| /dev/null test', 'env CI=1 time -p npm test', 'nice -- npm test',
    'vite --config vite.config.ts build', 'npx vite --config vite.config.ts build',
    './node_modules/.bin/vite --config vite.config.ts build', 'printf \'%s\' "$(npm test)"',
    'eslint . -- --help'].map((raw) => ({ raw, refused: true, subjects: [raw] })),
  ...['tsc --pretty false --showConfig', 'tsc --noEmit --showConfig', 'tsc --project tsconfig.json --showConfig',
    'tsc -p tsconfig.json --showConfig', 'vite build --help', 'vitest run --help', 'npx vitest run --help',
    "cat <<''\nnpm test\n\n", 'cat <<EOF\n\\$(npm test)\nEOF',
    'cat <<EOF\n\\`npm test\\`\nEOF'].map((raw) => ({ raw, refused: false, subjects: [raw] })),
);
for (const row of nativeCorpus) {
  if (row.refused) continue;
  if (row.raw.includes('--showConfig') || row.raw.includes('--version') || row.raw.includes('--help') && !row.raw.startsWith('printf')) row.output = 'owned diagnostic';
  else if (row.raw === 'npm view test') row.output = 'owned metadata';
  else if (row.raw.includes('X=1')) row.output = 'X=1 npm test -- --help';
  else if (row.raw.startsWith('command printf')) row.output = 'npm test example';
  else row.output = 'npm test';
}

export function nativeRuleMatches(rule, raw) {
  if (!rule.startsWith('Bash(')) return false;
  const pattern = rule.slice(5, -1);
  let expression = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) expression += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else expression += char === '*' ? '.*' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$', 's').test(raw);
}

export function simulatedNativeDenial(command, rules) {
  const row = nativeCorpus.find((entry) => entry.raw === command);
  // Unknown raw input remains raw: no production normalization, no guessed
  // recursive shell evaluation. The explanatory hook has separate coverage.
  return (row?.subjects ?? [command]).some((subject) => rules.some((rule) => nativeRuleMatches(rule, subject)));
}
