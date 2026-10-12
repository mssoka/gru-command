import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BlindInputRefusal,
  DEFAULT_BLIND_ISOLATION_RULE,
  classifyBlindPath,
  classifyHistoryContent,
  deriveBlindIsolationRule,
  evaluateBlindBriefing,
  evaluateBlindPackage,
  filterBlindDiff,
  gitBlobSha,
  parseBlindInputPackage,
  reviewRoleFor,
  scanObservedAccess,
} from '../src/dispatch/blind-input.js';
import type { JobAmendmentRecord } from '../src/review-inputs/amendments.js';

/**
 * Issue #316: a blind reviewer's input package is validated BEFORE a
 * reviewer turn is spent. These are deterministic input fixtures: no
 * reviewer, no network. History-bearing text is detected by what it SAYS
 * (structure), never by a file name, so a renamed `accepted-spec.md` is
 * caught while a source line that merely mentions a planning path is not.
 */

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// Built from line arrays so no fixture line starts a heading inside this file.
const HISTORY_NOTE = [
  '# Accepted spec',
  '',
  '## Prior replacement-blind assessment',
  'R5 findings: the reviewer said X.',
  'R7 findings: the reviewer said Y.',
  '## Triage',
  'disposition: acted',
].join('\n');

const TASK_SPEC = [
  '---',
  'title: Add the thing',
  'status: ready-for-dev',
  '---',
  '## Acceptance Criteria',
  '- it works',
].join('\n');

function amendment(version: number, body: string, extra: Partial<JobAmendmentRecord> = {}): JobAmendmentRecord {
  return {
    id: `am-${version}`,
    jobId: 'parent',
    version,
    body,
    bodySha256: sha(body),
    supersedes: [],
    approval: { by: 'owner', reference: 'test' },
    effect: 'administrative',
    previousContractSha256: '',
    contractSha256: '',
    requestSha256: '',
    idempotencyKey: null,
    createdAt: '2026-10-12T00:00:00Z',
    ...extra,
  };
}

describe('review role (claims-needed reviewers stay a separate contract)', () => {
  it('classifies explicit roles, infers blind from the lane name, and rejects unknown roles', () => {
    expect(reviewRoleFor({ explicit: 'blind', title: 'x' })).toBe('blind');
    expect(reviewRoleFor({ explicit: 'claims', title: 'review (blind)' })).toBe('claims');
    expect(reviewRoleFor({ title: 'review (blind)' })).toBe('blind');
    expect(reviewRoleFor({ title: 'edge review', displayName: 'Blinded by the light' })).toBeNull();
    expect(reviewRoleFor({ title: 'edge review' })).toBeNull();
    expect(() => reviewRoleFor({ explicit: 'psychic', title: 'x' })).toThrow(/review_role must be one of blind\|claims/u);
  });
});

describe('path and content classification', () => {
  it('excludes private job material by path but does not ban the whole config namespace', () => {
    const rule = DEFAULT_BLIND_ISOLATION_RULE;
    expect(classifyBlindPath('_bmad-output/specs/spec-x/spec.md', rule)).toMatch(/private job material/u);
    expect(classifyBlindPath('docs/issues/305-review.md', rule)).not.toBeNull();
    expect(classifyBlindPath('investigations/x.md', rule)).not.toBeNull();
    expect(classifyBlindPath('.gru-command/jobs/j-1/report.md', rule)).not.toBeNull();
    // The versioned config namespace stays usable.
    expect(classifyBlindPath('.gru-command/worktree.toml', rule)).toBeNull();
    expect(classifyBlindPath('src/dispatch/service.ts', rule)).toBeNull();
    // Traversal is never a valid package path.
    expect(classifyBlindPath('../outside/secret.md', rule)).toMatch(/invalid package path/u);
    expect(classifyBlindPath('/abs/path.ts', rule)).toMatch(/invalid package path/u);
  });

  it('detects history-bearing text by content, so a renamed spec is still caught', () => {
    expect(classifyHistoryContent(HISTORY_NOTE).excluded).toBe(true);
    expect(classifyHistoryContent(TASK_SPEC).excluded).toBe(true);
    expect(classifyHistoryContent('# Notes\n\nA plain design note about caches.\n').excluded).toBe(false);
  });

  it('does not treat a filename mentioned in legitimate source as exposure', () => {
    const source = [
      '// see _bmad-output/implementation-artifacts/deferred-work.md for context',
      "const path = '_bmad-output/specs/spec-x/spec.md';",
      "describe('prior assessment handling', () => {});",
    ].join('\n');
    const result = evaluateBlindPackage(
      { baseSha: 'b'.repeat(40), targetSha: 't'.repeat(40), files: [{ path: 'src/a.ts', content: source }] },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(result.ok).toBe(true);
  });
});

describe('blind package evaluation', () => {
  const base = 'b'.repeat(40);
  const target = 'c'.repeat(40);

  it('refuses a renamed assessment smuggled under an innocent name, with a correction path', () => {
    const result = evaluateBlindPackage(
      { baseSha: base, targetSha: target, files: [{ path: 'docs/accepted-spec.md', content: HISTORY_NOTE }] },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'history-content', where: 'docs/accepted-spec.md' }),
    ]);
  });

  it('refuses excluded planning paths and an embedded history section inside a larger markdown file', () => {
    const embedded = `# Design\n\nBody text.\n\n${HISTORY_NOTE}\n`;
    const result = evaluateBlindPackage(
      {
        baseSha: base,
        targetSha: target,
        files: [
          { path: '_bmad-output/implementation-artifacts/deferred-work.md', content: 'x' },
          { path: 'docs/design.md', content: embedded },
          { path: 'src/ok.ts', content: 'export const ok = 1;\n' },
        ],
      },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => `${v.code}:${v.where}`).sort()).toEqual([
      'excluded-path:_bmad-output/implementation-artifacts/deferred-work.md',
      'history-content:docs/design.md',
    ]);
  });

  it('preserves target and blob provenance for a valid immutable package', () => {
    const content = 'export const a = 1;\n';
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-export const a = 0;',
      '+export const a = 1;',
      '',
    ].join('\n');
    const result = evaluateBlindPackage(
      {
        baseSha: base,
        targetSha: target,
        diff: { text: diffText, sha256: sha(diffText) },
        files: [{ path: 'src/a.ts', content, sha256: sha(content), blobSha: gitBlobSha(content) }],
      },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(result.ok).toBe(true);
    expect(result.provenance).toMatchObject({
      baseSha: base,
      targetSha: target,
      diffSha256: sha(diffText),
      files: [{ path: 'src/a.ts', sha256: sha(content), blobSha: gitBlobSha(content) }],
    });
    expect(result.provenance?.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
    // Deterministic: the same package yields the same identity.
    const again = evaluateBlindPackage(
      { baseSha: base, targetSha: target, diff: { text: diffText }, files: [{ path: 'src/a.ts', content }] },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(again.provenance?.packageSha256).toBe(result.provenance?.packageSha256);
  });

  it('refuses a package whose declared digests do not match its bytes', () => {
    const result = evaluateBlindPackage(
      {
        baseSha: base,
        targetSha: target,
        files: [{ path: 'src/a.ts', content: 'real\n', sha256: sha('other\n'), blobSha: gitBlobSha('other\n') }],
      },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(result.violations.map((v) => v.code).sort()).toEqual(['digest-mismatch', 'digest-mismatch']);
  });

  it('refuses an empty package and a package with traversal paths', () => {
    expect(evaluateBlindPackage({ baseSha: base, targetSha: target }, DEFAULT_BLIND_ISOLATION_RULE).violations[0]).toMatchObject({
      code: 'empty-package',
    });
    const traversal = evaluateBlindPackage(
      { baseSha: base, targetSha: target, files: [{ path: '../x.ts', content: 'x' }] },
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(traversal.violations[0]).toMatchObject({ code: 'excluded-path' });
  });

  it('filters or refuses an unfiltered diff that carries planning artifacts, per file section', () => {
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/_bmad-output/implementation-artifacts/deferred-work.md b/_bmad-output/implementation-artifacts/deferred-work.md',
      '--- a/_bmad-output/implementation-artifacts/deferred-work.md',
      '+++ b/_bmad-output/implementation-artifacts/deferred-work.md',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/docs/accepted-spec.md b/docs/accepted-spec.md',
      '--- a/docs/accepted-spec.md',
      '+++ b/docs/accepted-spec.md',
      '@@ -1,3 +1,4 @@',
      ...HISTORY_NOTE.split('\n').map((line) => `+${line}`),
      '',
    ].join('\n');
    const filtered = filterBlindDiff(diffText, DEFAULT_BLIND_ISOLATION_RULE);
    expect(filtered.text).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(filtered.text).not.toContain('deferred-work');
    expect(filtered.text).not.toContain('Prior replacement-blind');
    expect(filtered.removed.map((v) => v.where).sort()).toEqual([
      '_bmad-output/implementation-artifacts/deferred-work.md',
      'docs/accepted-spec.md',
    ]);
    const refused = evaluateBlindPackage({ baseSha: base, targetSha: target, diff: { text: diffText } }, DEFAULT_BLIND_ISOLATION_RULE);
    expect(refused.ok).toBe(false);
    expect(refused.violations).toHaveLength(2);
  });

  it('refuses history-bearing prose embedded in the briefing itself', () => {
    expect(evaluateBlindBriefing('Review the immutable head. Read-only.', DEFAULT_BLIND_ISOLATION_RULE)).toEqual([]);
    expect(evaluateBlindBriefing(`Review this.\n\n${HISTORY_NOTE}`, DEFAULT_BLIND_ISOLATION_RULE)[0]).toMatchObject({
      code: 'history-content',
      where: 'briefing',
    });
  });
});

describe('effective parent isolation rule', () => {
  it('takes parent directives, including an administrative clarification, and honors permits for config only', () => {
    const rule = deriveBlindIsolationRule({
      briefing: 'Build it.\nblind-isolation: exclude .gru-command/**\n',
      amendments: [
        amendment(1, '- blind-isolation: permit .gru-command/worktree.toml\nblind-isolation: require-package'),
        amendment(2, 'blind-isolation: permit .gru-command/notes.md'),
      ],
    });
    expect(rule.requirePackage).toBe(true);
    expect(rule.directives).toBe(4);
    expect(classifyBlindPath('.gru-command/bmad-install.json', rule)).toMatch(/parent isolation rule/u);
    expect(classifyBlindPath('.gru-command/worktree.toml', rule)).toBeNull();
    // A permit never lifts private job material or a non-config file.
    expect(classifyBlindPath('.gru-command/notes.md', rule)).not.toBeNull();
    expect(rule.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('ignores directives from a superseded amendment and from a superseded original line', () => {
    const rule = deriveBlindIsolationRule({
      briefing: 'blind-isolation: exclude vendor/**\nblind-isolation: exclude legacy/**',
      amendments: [
        amendment(1, 'blind-isolation: exclude stale/**'),
        amendment(2, 'blind-isolation: exclude fresh/**', { supersedes: ['amendment:am-1', 'original:exclude legacy/**'] }),
      ],
    });
    expect(classifyBlindPath('vendor/a.ts', rule)).not.toBeNull();
    expect(classifyBlindPath('fresh/a.ts', rule)).not.toBeNull();
    expect(classifyBlindPath('stale/a.ts', rule)).toBeNull();
    expect(classifyBlindPath('legacy/a.ts', rule)).toBeNull();
  });

  it('a malformed directive fails loud', () => {
    expect(() => deriveBlindIsolationRule({ briefing: 'blind-isolation: banish everything', amendments: [] })).toThrow(
      /unknown blind-isolation directive/u,
    );
  });
});

describe('observed reviewer access', () => {
  it('flags grep output and paged reads that returned history, however the file is named', () => {
    const prohibited = scanObservedAccess(
      [
        { index: 3, toolName: 'bash', text: 'src/a.ts:10:const x = 1;' },
        { index: 5, toolName: 'bash', text: `accepted-spec.md:12:## Prior replacement-blind assessment\naccepted-spec.md:14:R7 findings: foo` },
        { index: 7, toolName: 'read', text: `12→## Prior replacement-blind assessment\n13→R7 findings: foo\n14→disposition: acted` },
        { index: 9, toolName: 'bash', text: '_bmad-output/implementation-artifacts/deferred-work.md:3:- item' },
        { index: 11, toolName: 'bash', text: 'a legitimate listing mentioning _bmad-output as a word' },
      ],
      DEFAULT_BLIND_ISOLATION_RULE,
    );
    expect(prohibited.map((p) => `${p.index}:${p.code}`)).toEqual([
      '5:history-content-read',
      '7:history-content-read',
      '9:excluded-path-read',
    ]);
    expect(prohibited[0]?.excerptSha256).toMatch(/^[0-9a-f]{64}$/u);
    // Private text never rides the record.
    expect(JSON.stringify(prohibited)).not.toContain('Prior replacement');
  });
});

describe('package request parsing', () => {
  it('rejects malformed packages loudly', () => {
    expect(() => parseBlindInputPackage('nope')).toThrow(BlindInputRefusal);
    expect(() => parseBlindInputPackage({ base_sha: 'a', target_sha: 'b', files: [{ path: 'x' }] })).toThrow(/content/u);
    expect(() => parseBlindInputPackage({ base_sha: 'a', target_sha: 'b', files: [{ path: 'x', content: 'y', extra: 1 }] })).toThrow(
      /unknown field/u,
    );
    expect(parseBlindInputPackage({ base_sha: 'a', target_sha: 'b', files: [{ path: 'x', content: 'y' }] })).toMatchObject({
      baseSha: 'a',
      targetSha: 'b',
    });
  });
});

describe('GC review workflow carries the isolation contract', () => {
  it('commissions the blind lens with a package and the claims lenses as a separate role, and the manifest pins the bytes', () => {
    const review = readFileSync('resources/gc-workflows/skills/gc-build/review.md', 'utf-8');
    expect(review).toContain('"review_role": "blind"');
    expect(review).toContain('"input_package"');
    expect(review).toContain('"parent_contract_sha256"');
    expect(review).toContain('blind-coverage');
    expect(review.match(/"review_role": "claims"/gu)).toHaveLength(2);
    const manifest = JSON.parse(readFileSync('resources/gc-workflows/runtime.json', 'utf-8')) as { files: Record<string, string> };
    expect(manifest.files['skills/gc-build/review.md']).toBe(createHash('sha256').update(review).digest('hex'));
  });
});
