import { readdirSync, readFileSync } from 'node:fs';
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

/** The rows of the markdown table between `<!-- name:start -->` and `<!-- name:end -->`. */
function table(doc: string, name: string): readonly Row[] {
  const start = doc.indexOf(`<!-- ${name}:start -->`);
  const end = doc.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`docs/RUNTIME-PARITY.md has no ${name} table between its markers`);
  return doc.slice(start, end).split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2) // header and separator
    .map((line) => ({ cells: line.split('|').slice(1, -1).map((cell) => cell.trim()) }));
}

const unquote = (cell: string): string => cell.replace(/^`|`$/gu, '');

interface Tag { readonly id: string; readonly runtime: string; readonly file: string; readonly title: string }

/** Every contract tag in a test title, across the test tree. */
function tags(): readonly Tag[] {
  const out: Tag[] = [];
  for (const name of readdirSync(join(root, 'test')).filter((entry) => entry.endsWith('.test.ts')).sort()) {
    const file = `test/${name}`;
    for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
      // (Spelled `(?:it)` so the static suite pin never counts this line as a test.)
      const title = /^\s*(?:it)(?:\.skipIf\([^)]*\))?\(\s*(['"`])(.*?)\1/u.exec(line)?.[2];
      if (title === undefined) continue;
      for (const match of title.matchAll(/#contract:([a-z0-9-]+):([a-z-]+)/gu)) {
        out.push({ id: match[1]!, runtime: match[2]!, file, title });
      }
    }
  }
  return out;
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

/** The top-level `describe` titles of an adapter test file. */
function topLevelBlocks(file: string): readonly string[] {
  return readFileSync(join(root, file), 'utf8').split('\n')
    .map((line) => /^describe\(\s*(['"`])(.*?)\1/u.exec(line)?.[2])
    .filter((title): title is string => title !== undefined);
}

describe('runtime parity guard (#374)', () => {
  const doc = readFileSync(join(root, 'docs', 'RUNTIME-PARITY.md'), 'utf8');
  const matrix = table(doc, 'parity-matrix');
  const blocks = table(doc, 'adapter-blocks');
  const found = tags();

  it('every contract in the matrix is proven on both runtimes, and every cell names its tagged test file', () => {
    const ids = matrix.map((row) => unquote(row.cells[0]!));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, 'contract ids are unique').toBe(ids.length);
    expect(parityProblems(matrix, found)).toEqual([]);
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
