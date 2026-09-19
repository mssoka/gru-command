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
    expect(nums).toContain(17);
    const block = spec.slice(spec.indexOf('17. **'), spec.indexOf('18. **'));
    expect(block).toContain('.agents/skills');
    expect(block).toContain('_bmad');
    // B1 (PR #8 r1): no rival ONLY-clause on the workspace root
    expect(block).not.toMatch(/workspace root\s+(holds|=)\s+ORCHESTRATION ONLY/i);
    expect(block).toContain('holds managed repos only');
    // no garbled duplicate fragments (B-r2-1, PR #8 r2)
    expect(block).not.toContain('carries its own — never at the workspace');
  });

  it('ruling 18 exists and is the worktree manager', () => {
    const nums = rulingNumbers(spec);
    expect(nums).toContain(18);
    const block = spec.slice(spec.indexOf('18. **'), spec.indexOf('19. **'));
    expect(block).toContain('.gru-command/worktree.toml');
    expect(block).toContain('PAUSES the sweep and ASKS');
    expect(block).toContain('Detached-for-reviews, branch-for-jobs');
  });

  it('rulings 19 and 20 are the attach/uploads and DecisionService canon (E9)', () => {
    const nums = rulingNumbers(spec);
    expect(nums.at(-1)).toBe(20);
    const block19 = spec.slice(spec.indexOf('19. **'), spec.indexOf('20. **'));
    expect(block19).toContain('by PATH');
    expect(block19).toContain('gru-command-attach1');
    expect(block19).toContain('<data_dir>/uploads/');
    expect(block19).toContain('DIRECTORY CREATION ONLY');
    // The amendment's operative attach semantics (user ruling 2026-09-18;
    // the attach1 lane splits only the IMPLEMENTATION — the ruling text
    // lives here): composer chips/preview with the user never typing
    // paths, path-sends with no byte copy, clipboard/phone materializing
    // into uploads, and the agent always receiving + reading a path.
    expect(block19).toContain('ready-to-send chips/preview');
    expect(block19).toContain('NEVER types or pastes paths');
    expect(block19).toContain('PATH with NO byte copy');
    expect(block19).toContain('materialize into the instance');
    expect(block19).toContain('ALWAYS receives a path and reads the file itself');
    expect(block19).toContain('vision gated on');
    expect(block19).toContain('graceful decline');
    const block20 = spec.slice(spec.indexOf('20. **'), spec.indexOf('## Sources'));
    expect(block20).toContain('DecisionService');
    expect(block20).toContain('src/events/bus.ts');
    expect(block20).toContain('src/supervision/supervisor.ts');
    expect(block20).toContain('src/worktrees/manager.ts');
    expect(block20).toContain('src/dispatch/perkins.ts');
    expect(block20).toContain('CONFIG-GATED,\n    DEFAULT-OFF');
    expect(block20).toContain('PROBE-VERIFIED before any real routing');
    expect(block20).toContain('~12× cheaper');
    expect(block20).toContain('openrouter.ai/api/alpha/decisions');
    expect(block20).toContain('docs.typesafe.ai/confidence.md');
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
