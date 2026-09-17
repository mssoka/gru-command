import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SPEC ruling-numbering drift pin (N4, Perkins r1 on PR #8): the
 * locked-rulings constitution is cited BY NUMBER across docs, src, and
 * tests — a silent renumber or insertion would corrupt every citation.
 * These pins freeze the count, the ordering, and the load-bearing
 * anchors (rulings 6/8/17 semantics cited in SPEC text and EPICS).
 */

const SPEC_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'SPEC.md');
const EPICS_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'EPICS.md');

const spec = readFileSync(SPEC_MD, 'utf-8');
const epics = readFileSync(EPICS_MD, 'utf-8');

function rulingNumbers(text: string): number[] {
  const block = text.slice(text.indexOf('## Locked rulings'), text.indexOf('## Sources'));
  return [...block.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
}

describe('SPEC locked-rulings numbering drift pin', () => {
  it('rulings are contiguous 1..N with no gaps or duplicates', () => {
    const nums = rulingNumbers(spec);
    expect(nums.length).toBeGreaterThan(0);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it('ruling 17 exists and is the per-project bmad/skills canon', () => {
    const nums = rulingNumbers(spec);
    expect(nums.at(-1)).toBe(17);
    const block = spec.slice(spec.indexOf('17. **'), spec.indexOf('## Sources'));
    expect(block).toContain('.agents/skills');
    expect(block).toContain('_bmad');
    // B1 (PR #8 r1): no rival ONLY-clause on the workspace root
    expect(block).not.toMatch(/workspace root\s+(holds|=)\s+ORCHESTRATION ONLY/i);
    expect(block).toContain('holds managed repos only');
  });

  it('load-bearing cross-references still cite the right numbers', () => {
    // ruling 6: workspace root holds the user's managed repos
    expect(spec).toMatch(/6\. \*\*Workspace root is config/);
    // ruling 8: the shared product repo ships orchestration only
    expect(spec).toMatch(/8\. \*\*Repo hygiene:\*\* the shared product repo ships orchestration only/);
    // EPICS E8 cites ruling-17 behaviors (dispatch cwd = project root)
    expect(epics).toContain('dispatch cwd = project root');
  });
});
