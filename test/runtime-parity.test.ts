import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The runtime parity guard (#374): docs/RUNTIME-PARITY.md lists every
 * runtime-dependent contract, and each contract's tests carry
 * `#contract:<id>:<pi|claude-code|neutral>` in their titles. A contract with a
 * test on one runtime only, a tag the matrix does not list, a matrix cell that
 * does not name its tagged test's file, or an unplaced top-level block in an
 * adapter test file fails here.
 */

const root = join(import.meta.dirname, '..');
const RUNTIMES = ['pi', 'claude-code'] as const;
const ADAPTER_FILES = ['test/pi-adapter.test.ts', 'test/claude-adapter.test.ts'] as const;

interface Row { readonly cells: readonly string[] }

/** The rows of the markdown table between `<!-- name:start -->` and `<!-- name:end -->`;
 * a row whose cell count differs from the header's is refused by name. */
function table(doc: string, name: string): readonly Row[] {
  const start = doc.indexOf(`<!-- ${name}:start -->`);
  const end = doc.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`docs/RUNTIME-PARITY.md has no ${name} table between its markers`);
  const lines = doc.slice(start, end).split('\n').filter((line) => line.startsWith('|'));
  if (lines.length < 3) throw new Error(`docs/RUNTIME-PARITY.md ${name} table has no header, separator or rows`);
  const cellsOf = (line: string): readonly string[] => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const width = cellsOf(lines[0] ?? '').length;
  return lines.slice(2).map((line) => { // header and separator
    const cells = cellsOf(line);
    if (cells.length !== width) throw new Error(`docs/RUNTIME-PARITY.md ${name} row has ${String(cells.length)} cells, not ${String(width)}: ${line}`);
    return { cells };
  });
}

const unquote = (cell: string): string => cell.replace(/^`|`$/gu, '');

interface Tag { readonly id: string; readonly runtime: string; readonly file: string; readonly title: string }

/** The title of the UNCONDITIONAL test a source line registers, or
 * undefined: a skipped or conditionally skipped test is no proof. A
 * backslash-escaped quote stays inside the title. (Spelled `(?:it)` so the
 * static suite pin never counts this line as a test.) */
function titleOf(line: string): string | undefined {
  return /^\s*(?:it)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/u.exec(line)?.[2];
}

const TAG = /^#contract:([a-z0-9-]+):(pi|claude-code|neutral)$/u;

/** Each line with whether it sits inside a `describe.skip`/`skipIf`/`runIf`/
 * `todo` block (by indentation): a test there is conditional, never proof. A
 * test that skips itself from its own body cannot be seen from here. */
function registeredLines(source: string): readonly { readonly line: string; readonly conditional: boolean }[] {
  const open: { readonly indent: number; readonly conditional: boolean }[] = [];
  return source.split('\n').map((line) => {
    const indent = line.length - line.trimStart().length;
    const block = /^\s*describe((?:\.[a-zA-Z]+)*)/u.exec(line);
    const closes = /^\s*\}\)/u.test(line);
    while (open.length > 0 && (indent < open.at(-1)!.indent || ((block !== null || closes) && indent === open.at(-1)!.indent))) open.pop();
    const conditional = open.some((entry) => entry.conditional);
    if (block !== null) open.push({ indent, conditional: conditional || (block[1] ?? '').split('.').some((modifier) => ['skip', 'skipIf', 'runIf', 'todo'].includes(modifier)) });
    return { line, conditional };
  });
}

/** Every contract tag in a test title, across the test tree; a token that
 * starts like a tag but is not one is returned as malformed, never dropped. */
function tags(): { readonly found: readonly Tag[]; readonly malformed: readonly string[] } {
  const found: Tag[] = [];
  const malformed: string[] = [];
  for (const name of readdirSync(join(root, 'test')).filter((entry) => entry.endsWith('.test.ts')).sort()) {
    const file = `test/${name}`;
    const one = tagsIn(file, readFileSync(join(root, file), 'utf8'));
    found.push(...one.found);
    malformed.push(...one.malformed);
  }
  return { found, malformed };
}

/** The tags one test file's unconditional tests carry. */
function tagsIn(file: string, source: string): { readonly found: readonly Tag[]; readonly malformed: readonly string[] } {
  const found: Tag[] = [];
  const malformed: string[] = [];
  for (const { line, conditional } of registeredLines(source)) {
    const title = titleOf(line);
    if (title === undefined || conditional) continue;
    for (const token of title.match(/#contract:\S*/gu) ?? []) {
      const match = TAG.exec(token);
      if (match === null) malformed.push(`${file}: ${token}`);
      else found.push({ id: match[1]!, runtime: match[2]!, file, title });
    }
  }
  return { found, malformed };
}

/** A runtime's tag never sits in the other runtime's adapter test file. */
function misplacedTags(found: readonly Tag[]): readonly string[] {
  const other: Readonly<Record<string, string>> = { pi: 'test/claude-adapter.test.ts', 'claude-code': 'test/pi-adapter.test.ts' };
  // A neutral test drives `AgentHandle`, so it never lives in an adapter's own file.
  const adapterFiles: readonly string[] = ADAPTER_FILES;
  return found.filter((tag) => other[tag.runtime] === tag.file || (tag.runtime === 'neutral' && adapterFiles.includes(tag.file)))
    .map((tag) => `${tag.file}: #contract:${tag.id}:${tag.runtime}`);
}

/** Every file a matrix cell names exists and holds a tag for that row's contract. */
function cellFileProblems(rows: readonly Row[], found: readonly Tag[]): readonly string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const id = unquote(row.cells[0]!);
    RUNTIMES.forEach((runtime, column) => {
      for (const [, file] of (row.cells[2 + column] ?? '').matchAll(/`(test\/[^`]+)`/gu)) {
        if (!existsSync(join(root, file!))) problems.push(`${id}: ${file!} does not exist`);
        else if (!found.some((tag) => tag.id === id && tag.file === file && (tag.runtime === runtime || tag.runtime === 'neutral'))) problems.push(`${id}: ${file!} holds no test tagged for it on ${runtime}`);
      }
    });
  }
  return problems;
}

/** What keeps the matrix from holding: a contract with no test on a runtime
 * (a neutral test counts for both), or a cell naming none of its tests' files. */
function parityProblems(rows: readonly Row[], found: readonly Tag[]): readonly string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const id = unquote(row.cells[0]!);
    const neutral = found.filter((tag) => tag.id === id && tag.runtime === 'neutral');
    RUNTIMES.forEach((runtime, column) => {
      const proving = [...neutral, ...found.filter((tag) => tag.id === id && tag.runtime === runtime)];
      if (proving.length === 0) {
        problems.push(`${id}: no test tagged #contract:${id}:${runtime} (or :neutral)`);
        return;
      }
      const cell = row.cells[2 + column] ?? '';
      if (!proving.some((tag) => cell.includes(`\`${tag.file}\``))) {
        problems.push(`${id}: the ${runtime} cell names none of ${[...new Set(proving.map((tag) => tag.file))].join(', ')}`);
      }
    });
  }
  return problems;
}

/** The top-level `describe` titles of an adapter test file, modifiers
 * (`describe.skip`, `describe.skipIf(…)`) and escaped quotes included. */
function topLevelBlocks(file: string): readonly string[] {
  return readFileSync(join(root, file), 'utf8').split('\n')
    .map(blockTitleOf)
    .filter((title): title is string => title !== undefined);
}

function blockTitleOf(line: string): string | undefined {
  return /^describe(?:\.[a-zA-Z]+(?:\([^)]*\))?)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/u.exec(line)?.[2];
}

describe('runtime parity guard (#374)', () => {
  const doc = readFileSync(join(root, 'docs', 'RUNTIME-PARITY.md'), 'utf8');
  const matrix = table(doc, 'parity-matrix');
  const blocks = table(doc, 'adapter-blocks');
  const gaps = table(doc, 'declared-gaps');
  const { found, malformed } = tags();

  it('every contract in the matrix is proven on both runtimes, and every cell names its tagged test file', () => {
    const ids = matrix.map((row) => unquote(row.cells[0]!));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, 'contract ids are unique').toBe(ids.length);
    expect(parityProblems(matrix, found)).toEqual([]);
  });

  it('no tag is malformed or sits in the other runtime\'s adapter file, and every file a cell names holds a tag for its row', () => {
    expect(malformed, 'malformed tags').toEqual([]);
    expect(misplacedTags(found), 'tags in the other runtime\'s adapter file').toEqual([]);
    expect(cellFileProblems(matrix, found)).toEqual([]);
  });

  it('every declared gap is a matrix row marked as one, with its issue, and every row marked as a gap is declared', () => {
    const ids = new Set(matrix.map((row) => unquote(row.cells[0]!)));
    const declared = gaps.map((row) => unquote(row.cells[0]!));
    expect(declared.filter((id) => !ids.has(id)), 'gaps naming no matrix row').toEqual([]);
    expect(gaps.filter((row) => !/^#\d+$/u.test(row.cells[2]!)).map((row) => row.cells[0]), 'gaps without an issue').toEqual([]);
    const marked = matrix.filter((row) => row.cells[1]!.startsWith('**Declared gap')).map((row) => unquote(row.cells[0]!));
    expect(marked.sort()).toEqual([...declared].sort());
  });

  it('every tag names a listed contract and a known runtime', () => {
    const ids = new Set(matrix.map((row) => unquote(row.cells[0]!)));
    const orphans = found.filter((tag) => !ids.has(tag.id) || ![...RUNTIMES, 'neutral'].includes(tag.runtime))
      .map((tag) => `${tag.file}: ${tag.title}`);
    expect(orphans).toEqual([]);
  });

  it('every top-level block of an adapter test file is placed in the block map, and every placement names a real block', () => {
    const ids = new Set(matrix.map((row) => unquote(row.cells[0]!)));
    const placed = new Map(blocks.map((row) => [`${unquote(row.cells[0]!)} › ${row.cells[1]!}`, row.cells[2]!]));
    const actual = ADAPTER_FILES.flatMap((file) => topLevelBlocks(file).map((title) => `${file} › ${title}`));
    expect(actual.filter((key) => !placed.has(key)), 'blocks the map does not place').toEqual([]);
    expect([...placed.keys()].filter((key) => !actual.includes(key)), 'placements of blocks that do not exist').toEqual([]);
    const kinds = [...placed.entries()].filter(([, kind]) => kind !== 'umbrella' && kind !== 'adapter-internal' && !ids.has(kind));
    expect(kinds.map(([key, kind]) => `${key}: ${kind}`), 'placements naming no listed contract').toEqual([]);
  });

  it('a test inside a skipped or conditional describe block is no proof, however deep', () => {
    const source = [`${'describe'}('kept', () => {`, `  ${'it'}('a #contract:x:pi', () => {});`, '});', `${'describe'}.skipIf(true)('gated', () => {`,
      `  ${'describe'}('inner', () => {`, `    ${'it'}('b #contract:x:pi', () => {});`, '  });', '});', `${'it'}('c #contract:x:pi', () => {});`,
      `${'describe'}.concurrent.skip('chained', () => {`, `  ${'it'}('d #contract:x:pi', () => {});`, '});'].join('\n');
    expect(registeredLines(source).filter((entry) => titleOf(entry.line) !== undefined).map((entry) => [titleOf(entry.line), entry.conditional]))
      .toEqual([['a #contract:x:pi', false], ['b #contract:x:pi', true], ['c #contract:x:pi', false], ['d #contract:x:pi', true]]);
    expect(tagsIn('test/x.test.ts', source).found.map((found) => found.title)).toEqual(['a #contract:x:pi', 'c #contract:x:pi']);
  });

  it('a conditionally skipped test is no proof; a describe with a modifier or an escaped quote is still a block', () => {
    // Built in parts so neither the suite pin nor this guard reads them as tests.
    expect(titleOf(`  ${'it'}.skipIf(process.platform === 'linux')('x #contract:spawn-cwd:pi', () => {`)).toBeUndefined();
    expect(blockTitleOf(`${'describe'}.skipIf(!macos)('sandbox on darwin', () => {`)).toBe('sandbox on darwin');
    expect(blockTitleOf(`${'describe'}('the job\\'s lane', () => {`)).toBe("the job\\'s lane");
  });

  it('a malformed tag, a tag in the other runtime\'s file, a missing or untagged cell file and a short row are each named', () => {
    const tag = (runtime: string, file: string): Tag => ({ id: 'x', runtime, file, title: 't' });
    expect(misplacedTags([tag('pi', 'test/claude-adapter.test.ts'), tag('claude-code', 'test/claude-adapter.test.ts')])).toEqual(['test/claude-adapter.test.ts: #contract:x:pi']);
    expect(cellFileProblems([{ cells: ['`x`', 'b', '`test/nope.test.ts`', '`test/runtime-parity.test.ts`'] }], []))
      .toEqual(['x: test/nope.test.ts does not exist', 'x: test/runtime-parity.test.ts holds no test tagged for it on claude-code']);
    expect(() => table('<!-- t:start -->\n| a | b |\n|---|---|\n| only |\n<!-- t:end -->', 't')).toThrow(/t row has 1 cells, not 2/u);
    expect(TAG.test('#contract:Foo_Bar:pi')).toBe(false);
    expect(misplacedTags([tag('neutral', 'test/pi-adapter.test.ts')])).toEqual(['test/pi-adapter.test.ts: #contract:x:neutral']);
    expect(cellFileProblems([{ cells: ['`x`', 'b', '`test/runtime-parity.test.ts`', '-'] }], [{ id: 'x', runtime: 'claude-code', file: 'test/runtime-parity.test.ts', title: 't' }]))
      .toEqual(['x: test/runtime-parity.test.ts holds no test tagged for it on pi']);
    expect(() => table('<!-- t:start -->\n| a | b |\n|---|---|\n<!-- t:end -->', 't')).toThrow(/t table has no header, separator or rows/u);
    expect(TAG.test('#contract:spawn-cwd:windows')).toBe(false);
  });

  it('a title holding an escaped quote is read whole, so its tags count', () => {
    // Built in parts so neither the suite pin nor this guard reads it as a test.
    const line = `  ${'it'}('the job\\'s lane, read whole #contract:spawn-cwd:pi', () => {`;
    expect(titleOf(line)).toBe("the job\\'s lane, read whole #contract:spawn-cwd:pi");
  });

  it('the check names a contract proven on one runtime only, and a cell that names another file', () => {
    const rows: readonly Row[] = [{ cells: ['`new-feature`', 'x', '`test/pi-adapter.test.ts`', '`test/claude-adapter.test.ts`'] }];
    const piOnly: readonly Tag[] = [{ id: 'new-feature', runtime: 'pi', file: 'test/pi-adapter.test.ts', title: 't' }];
    expect(parityProblems(rows, piOnly)).toEqual(['new-feature: no test tagged #contract:new-feature:claude-code (or :neutral)']);
    const misfiled: readonly Tag[] = [...piOnly, { id: 'new-feature', runtime: 'claude-code', file: 'test/other.test.ts', title: 't' }];
    expect(parityProblems(rows, misfiled)).toEqual(['new-feature: the claude-code cell names none of test/other.test.ts']);
    const neutral: readonly Tag[] = [{ id: 'new-feature', runtime: 'neutral', file: 'test/pi-adapter.test.ts', title: 't' }];
    expect(parityProblems([{ cells: ['`new-feature`', 'x', '`test/pi-adapter.test.ts`', '`test/pi-adapter.test.ts`'] }], neutral)).toEqual([]);
  });
});
