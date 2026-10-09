import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AWARENESS_BLOCK_HEADER, AWARENESS_WAKE_INSTRUCTION } from '../src/chat/awareness.js';
import { BOB_CONSOLIDATION_PROMPT } from '../src/dispatch/bob-scheduler.js';
import { buildWakePrompt, type SilasOpsDigest, type SilasTrigger, type SkillModule } from '../src/dispatch/silas-driver.js';
import { renderMinionBriefing } from '../src/dispatch/service.js';
import { renderRebriefPrompt } from '../src/dispatch/fix-directive.js';
import { renderDreamPrompt } from '../src/lessons/distiller.js';
import {
  aggregateUsage,
  buildYieldReport,
  classifyTurn,
  computeDigestStability,
  computeLedgerMeasures,
  digestSignatureFromPrompt,
  DIGEST_CATEGORY_KEYS,
  MINION_BRIEFING_PREFIX,
  MINION_REBRIEF_PREFIX,
  parseSessionLines,
  parseSilasWakeTrigger,
  PERKINS_LEAD_PROMPT_PREFIX,
  renderTextReport,
  SERVICE_WAKE_MARKER,
  SILAS_WAKE_PREFIX,
  sweepSignaturesOf,
  windowTurns,
  type LedgerEventRecord,
  type ParsedTurn,
} from '../src/telemetry/yield.js';
import {
  listSessionFiles,
  parseArgs,
  readLedger,
  requireIso,
  runYieldReport,
} from '../src/cli/yield-report.js';
import { LedgerDb } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const SINCE = '2026-10-01T00:00:00.000Z';
const UNTIL = '2026-10-02T00:00:00.000Z';

const emptyDigest: SilasOpsDigest = {
  computedAt: '2026-10-01T08:00:00.000Z',
  trigger: 'sweep',
  deliveredWithoutPr: [],
  prWithoutReview: [],
  verdictsAwaitingDirective: [],
  stalledWorking: [],
  minionErrors: [],
  verificationFailures: [],
  verificationWaits: [],
  providerRecoveryPending: [],
  conflictingPrs: [],
  releaseEligible: [],
  revisionContinuations: [], verificationsOwed: [],
};

const noSkills: readonly SkillModule[] = [];

function silasWakePrompt(kind: SilasTrigger['kind'], digest: SilasOpsDigest): string {
  return buildWakePrompt({
    digest,
    trigger: { kind },
    skills: noSkills,
    ops: { baseUrl: 'http://127.0.0.1:1', configPath: '/fixture/config.toml' },
  });
}

const gruWakeText = `${AWARENESS_BLOCK_HEADER}\nAction required (unacknowledged):\n- [11111111-1111-4111-8111-111111111111] title="x" — "y"\n\n${AWARENESS_WAKE_INSTRUCTION}`;

const gruOwnerAwareText = `${AWARENESS_BLOCK_HEADER}\nSince your last turn:\njob x: working → delivered`;

/** The wake instruction exactly as it shipped before GH-218/219 appended the
 * decision-memory order — every real 2026-09 wake prompt carries THIS text,
 * so the classifier must not depend on the live constant's tail. */
const HISTORICAL_WAKE_INSTRUCTION =
  'This turn was started by the service wake policy — no user message is waiting. ' +
  'This is machine attention and it is meant to be acted on in-turn: diagnose the item, ' +
  'take one substantive step per incident (a fix lane, a re-arm, or a disposition), and ' +
  'stage the rest. After acting on an action-required alert, explicitly resolve its ' +
  'notification ID with POST /api/notifications/{id}/disposition and a nonempty detail; ' +
  'prompt delivery alone never clears it. In all mode, FYI and needs-owner rows can also ' +
  'wake you; do not act on or Ack an owner-only stop on the owner’s behalf. Escalate ' +
  'decisions that are theirs; if nothing is actionable, say so briefly.';

const gruHistoricalWakeText = `${AWARENESS_BLOCK_HEADER}\nAction required (unacknowledged):\n- [22222222-2222-4222-8222-222222222222] title="PR #148 conflicts with its base" — "z"\n\n${HISTORICAL_WAKE_INSTRUCTION}`;

function assistantLine(overrides: {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cost?: number;
  readonly provider?: string;
  readonly model?: string;
}): string {
  return JSON.stringify({
    type: 'message',
    id: 'a',
    parentId: null,
    timestamp: '2026-10-01T00:00:01.000Z',
    message: {
      role: 'assistant',
      provider: overrides.provider ?? 'p',
      model: overrides.model ?? 'm',
      usage: {
        input: overrides.input ?? 0,
        output: overrides.output ?? 0,
        cacheRead: overrides.cacheRead ?? 0,
        cacheWrite: 0,
        reasoning: 0,
        cost: { total: overrides.cost ?? 0 },
      },
    },
  });
}

function userLine(timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'u',
    parentId: null,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function digestJson(jobIdsByCategory: Partial<Record<(typeof DIGEST_CATEGORY_KEYS)[number], readonly string[]>>): string {
  const digest: SilasOpsDigest = {
    ...emptyDigest,
    deliveredWithoutPr: (jobIdsByCategory.deliveredWithoutPr ?? []).map((jobId) => ({
      jobId,
      repo: 'r',
      branch: null,
      lanePath: null,
      minionSessionFile: null,
      deliveredAt: null,
    })),
    prWithoutReview: (jobIdsByCategory.prWithoutReview ?? []).map((jobId) => ({
      jobId,
      repo: 'r',
      prUrl: `https://example.test/${jobId}`,
      priorRounds: 0,
    })),
    stalledWorking: (jobIdsByCategory.stalledWorking ?? []).map((jobId) => ({
      jobId,
      repo: 'r',
      minionId: null,
      minionState: null,
      lastActivity: null,
      idleMs: 0,
    })),
    providerRecoveryPending: (jobIdsByCategory.providerRecoveryPending ?? []).map((waitId) => ({
      waitId,
      jobId: null,
      slotId: null,
      route: 'r',
      recoveredAt: '2026-10-01T00:00:00.000Z',
    })),
    conflictingPrs: (jobIdsByCategory.conflictingPrs ?? []).map((jobId) => ({
      jobId,
      repo: 'r',
      branch: null,
      prNumber: null,
      prUrl: null,
      headSha: 'sha',
      firstSeenAt: null,
    })),
  };
  return JSON.stringify(digest, null, 2);
}

/** A silas sweep wake prompt whose fenced digest carries the given rows. */
function sweepPromptWithDigest(categories: Partial<Record<(typeof DIGEST_CATEGORY_KEYS)[number], readonly string[]>>): string {
  const digestText = digestJson(categories);
  return `${SILAS_WAKE_PREFIX}sweep\n\n## Digest (actionable states, JSON)\n\n\`\`\`json\n${digestText}\n\`\`\`\n`;
}

// ------------------------------------------------------------------
// Attribution — pinned against the real prompt builders
// ------------------------------------------------------------------

describe('turn attribution follows the real prompt builders', () => {
  it('classifies a real buildWakePrompt sweep as trigger "sweep" and an event wake by its kind', () => {
    expect(classifyTurn('silas', silasWakePrompt('sweep', emptyDigest)).label).toBe('sweep');
    expect(classifyTurn('silas', silasWakePrompt('sweep', emptyDigest)).turnClass).toBe('machine');
    expect(classifyTurn('silas', silasWakePrompt('job.delivered', emptyDigest)).label).toBe('job.delivered');
    expect(classifyTurn('silas', silasWakePrompt('round.verdict', emptyDigest)).label).toBe('round.verdict');
  });

  it('refuses unbounded trigger kinds so prompt text can never become a report label', () => {
    expect(parseSilasWakeTrigger(`${SILAS_WAKE_PREFIX}sweep\n`)).toBe('sweep');
    expect(parseSilasWakeTrigger(`${SILAS_WAKE_PREFIX}job.delivered (job j-1)\n`)).toBe('job.delivered');
    expect(parseSilasWakeTrigger(`${SILAS_WAKE_PREFIX}SECRET secret SECRET\nrest of the prompt\n`)).toBeNull();
    expect(parseSilasWakeTrigger(`${SILAS_WAKE_PREFIX}${'x'.repeat(41)}\n`)).toBeNull();
    expect(classifyTurn('silas', `${SILAS_WAKE_PREFIX}not a bounded kind\n`).label).toBe('other');
  });

  it('keeps the retyped wake prefix aligned with buildWakePrompt output', () => {
    expect(silasWakePrompt('sweep', emptyDigest).startsWith(SILAS_WAKE_PREFIX)).toBe(true);
    expect(parseSilasWakeTrigger(silasWakePrompt('job.delivered', emptyDigest))).toBe('job.delivered');
  });

  it('classifies a service wake whose instruction predates later edits (real 2026-09 wording)', () => {
    // Fail-before: matching the whole live constant attributed all 202 real
    // historical wakes to owner turns, halving the reported machine share.
    expect(HISTORICAL_WAKE_INSTRUCTION).not.toBe(AWARENESS_WAKE_INSTRUCTION);
    expect(classifyTurn('gru', gruHistoricalWakeText)).toEqual({ label: 'service-wake', turnClass: 'machine' });
  });

  it('the wake instruction never orders a disposition of a producer-resolved alert — not even after a recorded hold (R10-02)', () => {
    expect(AWARENESS_WAKE_INSTRUCTION).toMatch(/A producer-resolved alert \(lessons\.dream-failed\) refuses a disposition: fix its cause and leave it open/u);
    const hold = AWARENESS_WAKE_INSTRUCTION.slice(AWARENESS_WAKE_INSTRUCTION.indexOf('When the right outcome is a hold'));
    expect(hold).toMatch(/^When the right outcome is a hold .*then disposition the alert — unless it is producer-resolved, which stays open even under a hold/u);
  });

  it('keeps the service-wake marker a prefix of the live wake instruction', () => {
    expect(AWARENESS_WAKE_INSTRUCTION.startsWith(SERVICE_WAKE_MARKER)).toBe(true);
    expect(HISTORICAL_WAKE_INSTRUCTION.startsWith(SERVICE_WAKE_MARKER)).toBe(true);
  });

  it('classifies gru service wakes, awareness-tagged owner turns and plain owner turns', () => {
    expect(classifyTurn('gru', gruWakeText)).toEqual({ label: 'service-wake', turnClass: 'machine' });
    expect(classifyTurn('gru', gruOwnerAwareText)).toEqual({ label: 'owner-turn+awareness', turnClass: 'owner' });
    expect(classifyTurn('gru', 'fix the login flow')).toEqual({ label: 'owner-turn', turnClass: 'owner' });
  });

  it('classifies bob consolidation and a real renderDreamPrompt pass as machine', () => {
    expect(classifyTurn('bob', BOB_CONSOLIDATION_PROMPT)).toEqual({ label: 'consolidation', turnClass: 'machine' });
    const dream = renderDreamPrompt({
      entries: [],
      index: null,
      bibleDir: '/fixture/book',
      chapterCapBytes: 1,
      indexCapBytes: 1,
      outputFile: '/fixture/out.json',
    });
    expect(classifyTurn('bob', dream)).toEqual({ label: 'dream', turnClass: 'machine' });
  });

  it('classifies a real renderMinionBriefing as briefing and renderRebriefPrompt as rebrief', () => {
    const briefing = renderMinionBriefing({
      jobId: 'j-1',
      repoName: 'repo',
      branch: 'gru/j-1',
      worktreePath: '/fixture/wt',
      sha: 'deadbeef',
      briefing: 'do the thing',
    });
    expect(classifyTurn('minion', briefing)).toEqual({ label: 'briefing', turnClass: 'delivery' });
    const rebrief = renderRebriefPrompt({ jobId: 'j-1', briefing: null, note: 'stalled' });
    expect(classifyTurn('minion', rebrief)).toEqual({ label: 'rebrief', turnClass: 'delivery' });
    expect(briefing.startsWith(MINION_BRIEFING_PREFIX)).toBe(true);
    expect(rebrief.startsWith(MINION_REBRIEF_PREFIX)).toBe(true);
  });

  it('classifies perkins lead prompts and lenses', () => {
    expect(classifyTurn('perkins', `${PERKINS_LEAD_PROMPT_PREFIX} of this whole change.`)).toEqual({
      label: 'lead',
      turnClass: 'delivery',
    });
    expect(classifyTurn('perkins', 'You are a cynical, precise reviewer…')).toEqual({
      label: 'lens',
      turnClass: 'delivery',
    });
  });

  it('pins the Perkins lead prefix against the builder source (leadPrompt is not exported)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/dispatch/perkins-review/whole.ts', import.meta.url)),
      'utf8',
    );
    expect(source.includes(PERKINS_LEAD_PROMPT_PREFIX)).toBe(true);
  });

  it('unrecognized minion traffic lands in directive/other, unknown silas/bob text in other', () => {
    expect(classifyTurn('minion', 'carry this crate')).toEqual({ label: 'directive/other', turnClass: 'delivery' });
    expect(classifyTurn('silas', 'casual chatter')).toEqual({ label: 'other', turnClass: 'machine' });
    expect(classifyTurn('bob', 'casual chatter')).toEqual({ label: 'other', turnClass: 'machine' });
  });
});

// ------------------------------------------------------------------
// Session parsing
// ------------------------------------------------------------------

describe('parseSessionLines', () => {
  it('folds one user message plus its assistant messages into one attributed turn', async () => {
    const parsed = await parseSessionLines('gru', [
      userLine('2026-10-01T00:00:00.000Z', gruWakeText),
      assistantLine({ input: 10, output: 5, cacheRead: 3, cost: 0.25 }),
      assistantLine({ input: 10, output: 5, cost: 0.25, provider: 'p2', model: 'm2' }),
      userLine('2026-10-01T01:00:00.000Z', 'now the owner speaks'),
      assistantLine({ input: 7, output: 2, cost: 1 }),
    ]);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'gru',
      label: 'service-wake',
      turnClass: 'machine',
      startedAt: '2026-10-01T00:00:00.000Z',
      llmCalls: 2,
      costUsd: 0.5,
      compactions: 0,
    });
    expect(parsed.turns[0]?.tokens).toEqual({ input: 20, output: 10, cacheRead: 3, cacheWrite: 0, reasoning: 0 });
    expect(parsed.turns[0]?.models).toEqual([
      { provider: 'p', model: 'm', costUsd: 0.25 },
      { provider: 'p2', model: 'm2', costUsd: 0.25 },
    ]);
    expect(parsed.turns[1]).toMatchObject({ label: 'owner-turn', turnClass: 'owner', llmCalls: 1, costUsd: 1 });
    expect(parsed.unparsableLines).toBe(0);
  });

  it('attributes compactions to the open turn and counts pre-turn compactions separately', async () => {
    const parsed = await parseSessionLines('silas', [
      JSON.stringify({ type: 'compaction' }),
      userLine('2026-10-01T00:00:00.000Z', silasWakePrompt('sweep', emptyDigest)),
      JSON.stringify({ type: 'compaction' }),
      assistantLine({ cost: 0.1 }),
    ]);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.compactions).toBe(1);
    expect(parsed.unattributedCompactions).toBe(1);
  });

  it('counts unparsable lines instead of throwing and ignores assistant chatter before any turn', async () => {
    const parsed = await parseSessionLines('bob', [
      'not json at all',
      assistantLine({ cost: 9 }),
      userLine('2026-10-01T00:00:00.000Z', BOB_CONSOLIDATION_PROMPT),
      assistantLine({ cost: 0.5 }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [] } }),
    ]);
    expect(parsed.turns).toEqual([expect.objectContaining({ label: 'consolidation', costUsd: 0.5 })]);
    expect(parsed.unparsableLines).toBe(1);
  });

  it('carries the digest signature on silas turns and null elsewhere', async () => {
    const prompt = sweepPromptWithDigest({ deliveredWithoutPr: ['job-b', 'job-a'] });
    const parsed = await parseSessionLines('silas', [userLine('2026-10-01T00:00:00.000Z', prompt), assistantLine({})]);
    expect(parsed.turns[0]?.digestSignature).not.toBeNull();
    const gru = await parseSessionLines('gru', [userLine('2026-10-01T00:00:00.000Z', gruWakeText), assistantLine({})]);
    expect(gru.turns[0]?.digestSignature).toBeNull();
  });

  it('treats a digest with no actionable categories or a corrupt value as malformed', () => {
    const headerOnly = `## Digest (actionable states, JSON)\n\n\`\`\`json\n${JSON.stringify({ computedAt: 'x', trigger: 'sweep' })}\n\`\`\``;
    expect(digestSignatureFromPrompt(headerOnly)).toBeNull();
    const corrupt = `## Digest (actionable states, JSON)\n\n\`\`\`json\n${JSON.stringify({ computedAt: 'x', trigger: 'sweep', deliveredWithoutPr: 'oops' })}\n\`\`\``;
    expect(digestSignatureFromPrompt(corrupt)).toBeNull();
    // Older digest formats predate newer categories: a digest with SOME
    // categories present is a real digest, and missing keys count as empty.
    const older = `## Digest (actionable states, JSON)\n\n\`\`\`json\n${JSON.stringify({ computedAt: 'x', trigger: 'sweep', deliveredWithoutPr: [] })}\n\`\`\``;
    expect(digestSignatureFromPrompt(older)).not.toBeNull();
  });

  it('a user message without a timestamp is skipped and counted, not attributed', async () => {
    const line = JSON.stringify({ type: 'message', timestamp: 123, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } });
    const parsed = await parseSessionLines('gru', [line]);
    expect(parsed.turns).toHaveLength(0);
    expect(parsed.unparsableLines).toBe(1);
  });
});

// ------------------------------------------------------------------
// Digest signature
// ------------------------------------------------------------------

describe('digestSignatureFromPrompt', () => {
  it('reduces the digest to sorted job IDs per category and ignores computedAt churn', () => {
    const a = sweepPromptWithDigest({ deliveredWithoutPr: ['job-b', 'job-a'], prWithoutReview: ['job-c'] });
    const b = sweepPromptWithDigest({ deliveredWithoutPr: ['job-a', 'job-b'], prWithoutReview: ['job-c'] });
    const signatureA = digestSignatureFromPrompt(a);
    expect(signatureA).not.toBeNull();
    expect(signatureA).toBe(digestSignatureFromPrompt(b));
    const parsedA = JSON.parse(signatureA ?? '') as Record<string, string[]>;
    expect(parsedA['deliveredWithoutPr']).toEqual(['job-a', 'job-b']);
    expect(parsedA['prWithoutReview']).toEqual(['job-c']);
    expect(parsedA['minionErrors']).toEqual([]);
  });

  it('a stalled-working row changes the signature — every actionable category participates', () => {
    const without = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'] }));
    const withStalled = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'], stalledWorking: ['job-s'] }));
    expect(withStalled).not.toBeNull();
    expect(withStalled).not.toBe(without);
    expect((JSON.parse(withStalled ?? '') as Record<string, string[]>)['stalledWorking']).toEqual(['job-s']);
  });

  it('falls back to wait IDs for provider-recovery rows and changes when rows change', () => {
    const withWait = digestSignatureFromPrompt(sweepPromptWithDigest({ providerRecoveryPending: ['wait-1'] }));
    const withOtherWait = digestSignatureFromPrompt(sweepPromptWithDigest({ providerRecoveryPending: ['wait-2'] }));
    expect(withWait).not.toBeNull();
    expect(withWait).not.toBe(withOtherWait);
    expect((JSON.parse(withWait ?? '') as Record<string, string[]>)['providerRecoveryPending']).toEqual(['wait-1']);
  });

  it('a conflicting-PR row participates in the signature (GH-215 category adoption)', () => {
    const without = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'] }));
    const withConflict = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'], conflictingPrs: ['job-conf'] }));
    expect(withConflict).not.toBeNull();
    expect(withConflict).not.toBe(without);
    expect((JSON.parse(withConflict ?? '') as Record<string, string[]>)['conflictingPrs']).toEqual(['job-conf']);
  });

  it('returns null for prompts without a parseable digest', () => {
    expect(digestSignatureFromPrompt('no digest here')).toBeNull();
    expect(digestSignatureFromPrompt('## Digest (actionable states, JSON)\n\n```json\n{broken\n```')).toBeNull();
  });

  it('a fingerprint-bearing wake attributes directly — full and delta prompts alike (issue #217, review r1)', () => {
    const fp = 'a'.repeat(64);
    const full = `Silas ops wake — trigger: sweep\n\n## Digest (actionable states, JSON)\n\nDigest fingerprint: ${fp}\n\n\`\`\`json\n${JSON.stringify({ computedAt: 'x', trigger: 'sweep', deliveredWithoutPr: [] })}\n\`\`\``;
    expect(digestSignatureFromPrompt(full)).toBe(`fp:${fp}`);
    const delta = `Silas ops wake — trigger: sweep\n\n## Digest delta (since the last delivered wake)\n\nDigest fingerprint: ${fp}\n\nAdded rows:\n\n\`\`\`json\n[]\n\`\`\`\n\nFull digest: GET http://127.0.0.1:1/api/silas/digest`;
    expect(digestSignatureFromPrompt(delta)).toBe(`fp:${fp}`);
    // a different fingerprint is a different signature
    const fp2 = 'b'.repeat(64);
    const delta2 = delta.replace(fp, fp2);
    expect(digestSignatureFromPrompt(delta2)).not.toBe(digestSignatureFromPrompt(delta));
    // a malformed fingerprint line never matches
    expect(digestSignatureFromPrompt('Digest fingerprint: nothex')).toBeNull();
  });
});

// ------------------------------------------------------------------
// Usage aggregation
// ------------------------------------------------------------------

describe('aggregateUsage', () => {
  it('buckets by label, class and model with totals including per-model cost', () => {
    const turns: ParsedTurn[] = [
      makeTurn({ role: 'gru', label: 'service-wake', turnClass: 'machine', llmCalls: 2, costUsd: 2, models: [{ provider: 'p', model: 'm', costUsd: 0.5 }, { provider: 'p', model: 'm', costUsd: 1.5 }] }),
      makeTurn({ role: 'gru', label: 'owner-turn', turnClass: 'owner', llmCalls: 1, costUsd: 3, models: [{ provider: 'p', model: 'm', costUsd: 3 }] }),
      makeTurn({ role: 'silas', label: 'sweep', turnClass: 'machine', llmCalls: 1, costUsd: 1, models: [{ provider: 'q', model: 'z', costUsd: 1 }] }),
    ];
    const usage = aggregateUsage(turns);
    expect(usage.total.costUsd).toBe(6);
    expect(usage.total.turns).toBe(3);
    expect(usage.byClass.machine.costUsd).toBe(3);
    expect(usage.byClass.owner.costUsd).toBe(3);
    expect(usage.byClass.delivery.costUsd).toBe(0);
    const sweep = usage.byLabel.find((label) => label.label === 'sweep');
    expect(sweep).toMatchObject({ role: 'silas', turns: 1, llmCalls: 1, costUsd: 1 });
    expect(usage.byModel).toEqual([
      { provider: 'p', model: 'm', llmCalls: 3, costUsd: 5 },
      { provider: 'q', model: 'z', llmCalls: 1, costUsd: 1 },
    ]);
  });
});

function makeTurn(overrides: {
  role: ParsedTurn['role'];
  label: string;
  turnClass: ParsedTurn['turnClass'];
  llmCalls?: number;
  costUsd?: number;
  models?: readonly { provider: string; model: string; costUsd: number }[];
  startedAt?: string;
}): ParsedTurn {
  return {
    role: overrides.role,
    label: overrides.label,
    turnClass: overrides.turnClass,
    startedAt: overrides.startedAt ?? SINCE,
    llmCalls: overrides.llmCalls ?? 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costUsd: overrides.costUsd ?? 0,
    compactions: 0,
    digestSignature: null,
    models: [...(overrides.models ?? [])],
  };
}

// ------------------------------------------------------------------
// Ledger measures
// ------------------------------------------------------------------

function event(kind: string, ts: string, extra: { jobId?: string | null; payload?: unknown; seq?: number } = {}): LedgerEventRecord {
  return { seq: extra.seq ?? 0, ts, kind, jobId: extra.jobId ?? null, payload: extra.payload ?? {} };
}

function measureInput(events: LedgerEventRecord[]) {
  return {
    since: SINCE,
    until: UNTIL,
    events,
    notifications: [
      { id: 'conflict-1', kind: 'github.pr-conflict:job-x' },
      { id: 'conflict-2', kind: 'github.pr-conflict:job-y' },
      { id: 'error-1', kind: 'agent.error' },
    ],
    jobs: [
      { id: 'finished-1', createdAt: '2026-09-30T00:00:00.000Z' },
      { id: 'finished-2', createdAt: '2026-10-01T06:00:00.000Z' },
      { id: 'wip-1', createdAt: '2026-09-15T00:00:00.000Z' },
      { id: 'wip-2', createdAt: '2026-10-01T12:00:00.000Z' },
      { id: 'old-done', createdAt: '2026-09-01T00:00:00.000Z' },
    ],
  };
}

describe('computeLedgerMeasures', () => {
  it('windows silas yield actions to the gap before the next wake', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('silas.wake', '2026-10-01T01:00:00.000Z', { payload: { trigger: 'sweep', actionable: 3 } }),
        event('silas.directive-sent', '2026-10-01T01:05:00.000Z'),
        event('silas.wake', '2026-10-01T02:00:00.000Z', { payload: { trigger: 'sweep', actionable: 3 } }),
        event('silas.escalated', '2026-10-01T02:30:00.000Z'),
        event('silas.wake', '2026-10-01T03:00:00.000Z', { payload: { trigger: 'sweep', actionable: 3 } }),
      ]),
      [],
    );
    expect(measures.silasYield.wakes).toBe(3);
    expect(measures.silasYield.wakesWithAction).toBe(2);
    expect(measures.silasYield.noActionShare).toBeCloseTo(1 / 3);
    expect(measures.silasYield.actionsByKind).toEqual({ 'silas.directive-sent': 1, 'silas.escalated': 1 });
    expect(measures.silasYield.byTrigger).toEqual([
      { trigger: 'sweep', wakes: 3, wakesWithAction: 2 },
    ]);
  });

  it('a sweep-ack release attributes to its wake like every other silas action (issue #117)', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('silas.wake', '2026-10-01T01:00:00.000Z', { payload: { trigger: 'sweep', actionable: 1 } }),
        event('silas.lane-released', '2026-10-01T01:05:00.000Z'),
        event('silas.wake', '2026-10-01T02:00:00.000Z', { payload: { trigger: 'sweep', actionable: 0 } }),
      ]),
      [],
    );
    expect(measures.silasYield.wakes).toBe(2);
    expect(measures.silasYield.wakesWithAction).toBe(1);
    expect(measures.silasYield.actionsByKind).toEqual({ 'silas.lane-released': 1 });
  });

  it('orders same-timestamp events by sequence: each action lands in exactly one window', () => {
    // wake1 seq 1 and wake2 seq 3 share a timestamp; the action in between
    // (seq 2) belongs to wake1, the action after (seq 4) to wake2.
    const shared = '2026-10-01T02:00:00.000Z';
    const measures = computeLedgerMeasures(
      measureInput([
        event('silas.wake', '2026-10-01T01:00:00.000Z', { payload: { trigger: 'sweep' }, seq: 1 }),
        event('silas.wake', shared, { payload: { trigger: 'sweep' }, seq: 3 }),
        event('silas.directive-sent', shared, { seq: 2 }),
        event('silas.escalated', shared, { seq: 4 }),
      ]),
      [],
    );
    expect(measures.silasYield.actionsByKind).toEqual({ 'silas.directive-sent': 1, 'silas.escalated': 1 });
    expect(measures.silasYield.wakes).toBe(2);
    expect(measures.silasYield.wakesWithAction).toBe(2);
  });

  it('an action at the exclusive window end belongs to no wake', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('silas.wake', '2026-10-01T01:00:00.000Z', { payload: { trigger: 'sweep' } }),
        event('silas.directive-sent', UNTIL),
      ]),
      [],
    );
    expect(measures.silasYield.actionsByKind).toEqual({});
    expect(measures.silasYield.wakesWithAction).toBe(0);
    expect(measures.silasYield.noActionShare).toBe(1);
  });

  it('windows gru yield actions to the gap before the next wake', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('gru.wake', '2026-09-30T23:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
        event('gru.wake', '2026-10-01T01:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
        event('notification.resolved', '2026-10-01T01:10:00.000Z'),
        event('gru.wake', '2026-10-01T04:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
      ]),
      [],
    );
    expect(measures.gruYield.wakes).toBe(2); // the 09-30 wake is outside the window
    expect(measures.gruYield.wakesWithAction).toBe(1);
    expect(measures.gruYield.noActionShare).toBeCloseTo(0.5);
  });

  it('computes digest stability over chronological sweeps with predecessors only, across the window edge', () => {
    const sigA = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'] }));
    const sigB = digestSignatureFromPrompt(sweepPromptWithDigest({ deliveredWithoutPr: ['job-b'] }));
    const stability = computeDigestStability(
      [
        ['2026-10-01T03:00:00.000Z', sigB ?? ''],
        ['2026-10-01T01:00:00.000Z', sigA ?? ''],
        ['2026-10-01T02:00:00.000Z', sigA ?? ''],
      ],
      SINCE,
      UNTIL,
    );
    expect(stability).toEqual({ sweeps: 3, stable: 1, share: 0.5 });
    // The first in-window sweep compares against the last sweep BEFORE the
    // window: it counts, and its signature matches, so share is 1.
    const edge = computeDigestStability(
      [
        ['2026-09-30T23:00:00.000Z', sigA ?? ''],
        ['2026-10-01T01:00:00.000Z', sigA ?? ''],
      ],
      SINCE,
      UNTIL,
    );
    expect(edge).toEqual({ sweeps: 1, stable: 1, share: 1 });
    // Different pre-window digest: the in-window sweep is comparable and unstable.
    const edgeDifferent = computeDigestStability(
      [
        ['2026-09-30T23:00:00.000Z', sigB ?? ''],
        ['2026-10-01T01:00:00.000Z', sigA ?? ''],
      ],
      SINCE,
      UNTIL,
    );
    expect(edgeDifferent).toEqual({ sweeps: 1, stable: 0, share: 0 });
    expect(computeDigestStability([['2026-10-01T01:00:00.000Z', sigA ?? '']], SINCE, UNTIL)).toEqual({
      sweeps: 1,
      stable: 0,
      share: null,
    });
  });

  it('joins gru wake notification ids to kinds and flags conflict-only and repeat incidents', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('gru.wake', '2026-10-01T01:00:00.000Z', { payload: { notification_ids: ['conflict-1'] } }),
        event('gru.wake', '2026-10-01T02:00:00.000Z', { payload: { notification_ids: ['conflict-1', 'conflict-2'] } }),
        event('gru.wake', '2026-10-01T03:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
      ]),
      [],
    );
    expect(measures.gruWakeCauses.wakesWithNotificationIds).toBe(3);
    expect(measures.gruWakeCauses.conflictOnlyWakes).toBe(2);
    expect(measures.gruWakeCauses.repeatIncidentIds).toBe(1);
    expect(measures.gruWakeCauses.wakesWithRepeatIncident).toBe(2);
    expect(measures.gruWakeCauses.perKind).toEqual([
      { kind: 'github.pr-conflict:job-x', wakes: 2 },
      { kind: 'agent.error', wakes: 1 },
      { kind: 'github.pr-conflict:job-y', wakes: 1 },
    ]);
  });

  it('a duplicate id inside one wake is one incident, and a kind counts once per wake', () => {
    const measures = computeLedgerMeasures(
      measureInput([
        event('gru.wake', '2026-10-01T01:00:00.000Z', { payload: { notification_ids: ['conflict-1', 'conflict-1', 'conflict-2', 'conflict-2'] } }),
      ]),
      [],
    );
    expect(measures.gruWakeCauses.repeatIncidentIds).toBe(0);
    expect(measures.gruWakeCauses.wakesWithRepeatIncident).toBe(0);
    expect(measures.gruWakeCauses.perKind).toEqual([
      { kind: 'github.pr-conflict:job-x', wakes: 1 },
      { kind: 'github.pr-conflict:job-y', wakes: 1 },
    ]);
  });

  it('reports wakes/day and the avoided share from the avoidance stream (issue #219, #214)', () => {
    // SINCE..UNTIL spans exactly one day (2026-10-01, see the constants).
    const measures = computeLedgerMeasures(
      measureInput([
        event('gru.wake', '2026-10-01T01:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
        event('gru.wake', '2026-10-01T05:00:00.000Z', { payload: { notification_ids: ['error-1'] } }),
        event('gru.wake-deferred', '2026-10-01T02:00:00.000Z', { payload: { reason: 'duplicate', notification_id: 'dup-1', incident_key: 'k1' } }),
        event('gru.wake-deferred', '2026-10-01T03:00:00.000Z', { payload: { reason: 'covered', notification_id: 'cov-1', incident_key: 'k2', decision_id: 'd1' } }),
        event('gru.wake-deferred', '2026-10-01T04:00:00.000Z', { payload: { reason: 'failed', notification_id: 'fail-1', incident_key: 'k3' } }),
        event('gru.wake-deferred', '2026-09-30T23:00:00.000Z', { payload: { reason: 'covered', notification_id: 'pre-window', incident_key: 'k4' } }),
      ]),
      [],
    );
    expect(measures.gruWakeCauses.wakesPerDay).toBeCloseTo(2, 9);
    expect(measures.gruWakeCauses.avoided).toEqual({ duplicates: 1, covered: 1, share: 2 / 4 });
  });

  it('an empty window reports a null avoided share and zero wakes/day', () => {
    const measures = computeLedgerMeasures(measureInput([]), []);
    expect(measures.gruWakeCauses.wakesPerDay).toBe(0);
    expect(measures.gruWakeCauses.avoided).toEqual({ duplicates: 0, covered: 0, share: null });
  });

  it('counts finished heists in the window, lead times, and replays WIP to until', () => {
    const input = measureInput([
      event('job.created', '2026-09-30T00:00:00.000Z', { jobId: 'finished-1' }),
      event('job.status', '2026-10-01T09:00:00.000Z', { jobId: 'finished-1', payload: { from: 'in-review', to: 'merged' } }),
      event('job.status', '2026-10-01T18:00:00.000Z', { jobId: 'finished-2', payload: { from: 'working', to: 'done' } }),
      event('job.status', '2026-10-01T12:00:00.000Z', { jobId: 'wip-1', payload: { from: 'dispatched', to: 'working' } }),
      // A terminal transition before the window must not count as finished.
      event('job.status', '2026-09-02T00:00:00.000Z', { jobId: 'old-done', payload: { from: 'working', to: 'done' } }),
      // A discard (binned) leaves the flow: it must neither inflate the
      // finished-success count nor linger as WIP.
      event('job.status', '2026-10-01T15:00:00.000Z', { jobId: 'discard-1', payload: { from: 'working', to: 'binned' } }),
    ]);
    input.jobs = [...input.jobs, { id: 'discard-1', createdAt: '2026-09-30T12:00:00.000Z' }];
    const measures = computeLedgerMeasures(input, []);
    expect(measures.m0.finishedJobs).toBe(2); // the discard is not a finished success
    // finished-1: 09-30T00:00 → 10-01T09:00 = 33h; finished-2: 10-01T06:00 → 18:00 = 12h.
    expect(measures.m0.leadTimeHours).toEqual({ median: 22.5, max: 33 });
    expect(measures.m0.costPerFinishedUsd).toBeNull(); // filled by buildYieldReport
    expect(measures.m0.wipTotal).toBe(2); // and the discard is not WIP either
    // wip-1: 09-15T00:00 → window end = 408h; wip-2: 10-01T12:00 → 12h.
    // Equal counts tie-break alphabetically: dispatched before working.
    expect(measures.m0.wipByStatus).toEqual([
      { status: 'dispatched', jobs: 1, medianAgeHours: 12 },
      { status: 'working', jobs: 1, medianAgeHours: 408 },
    ]);
  });
});

// ------------------------------------------------------------------
// Report assembly + rendering
// ------------------------------------------------------------------

describe('buildYieldReport and renderTextReport', () => {
  const gruTurn: ParsedTurn = {
    ...makeTurn({ role: 'gru', label: 'service-wake', turnClass: 'machine', costUsd: 2 }),
    tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, reasoning: 0 },
  };
  const ownerTurn = makeTurn({ role: 'gru', label: 'owner-turn', turnClass: 'owner', costUsd: 3 });

  it('windows turns and assembles every section', () => {
    const report = buildYieldReport({
      since: SINCE,
      until: UNTIL,
      generatedAt: UNTIL,
      parseSkips: { unparsableLines: 2, unattributedCompactions: 0 },
      // The caller windows the turns (the CLI does); feed the report the
      // pre-windowed set exactly as production would.
      turns: windowTurns(
        [
          gruTurn,
          ownerTurn,
          makeTurn({ startedAt: '2026-09-30T23:59:59.000Z', role: 'gru', label: 'owner-turn', turnClass: 'owner' }),
        ],
        SINCE,
        UNTIL,
      ),
      sweepSignatures: [['2026-10-01T01:00:00.000Z', '{"deliveredWithoutPr":["a"]}']],
      ledger: measureInput([
        event('silas.wake', '2026-10-01T01:00:00.000Z', { payload: { trigger: 'sweep' } }),
        event('gru.wake', '2026-10-01T02:00:00.000Z', { payload: { notification_ids: ['conflict-1'] } }),
        event('job.status', '2026-10-01T09:00:00.000Z', { jobId: 'finished-1', payload: { from: 'in-review', to: 'merged' } }),
      ]),
    });
    expect(report.usage.total.turns).toBe(2);
    expect(report.usage.total.costUsd).toBe(5);
    expect(report.silasYield.wakes).toBe(1);
    expect(report.gruWakeCauses.conflictOnlyWakes).toBe(1);
    expect(report.m0.finishedJobs).toBe(1);
    // finished-2 and old-done have no terminal event in this fixture, so
    // they replay as dispatched WIP alongside wip-1 and wip-2.
    expect(report.m0.wipTotal).toBe(4);

    const text = renderTextReport(report);
    expect(text).toContain('Usage by trigger');
    expect(text).toContain('service-wake');
    expect(text).toContain('no-action share');
    expect(text).toContain('finished in window 1');
    expect(text).toContain('non-terminal WIP 4');
    expect(text).toContain('cost per finished heist $5.00');
    expect(text).toContain('unparsable lines');
    // Issue #219 / #214: the cost headline renders (deleting the line must
    // fail this test, not just the measures assertions above).
    expect(text).toMatch(/wakes\/day [\d.]+/);
    expect(text).toMatch(/avoided \d+ duplicate\(s\) \+ \d+ covered \(\d+(\.\d+)?%|n\/a\)/);
  });

  it('never prints prompt or transcript text — counts and bounded identifiers only', async () => {
    const secretMarker = 'SECRET-PAIRING-TOKEN-DO-NOT-PRINT';
    const parsed = await parseSessionLines('gru', [userLine(SINCE, `${gruWakeText}\n${secretMarker}`), assistantLine({})]);
    const report = buildYieldReport({
      since: SINCE,
      until: UNTIL,
      generatedAt: UNTIL,
      parseSkips: { unparsableLines: 0, unattributedCompactions: 0 },
      turns: parsed.turns,
      sweepSignatures: [],
      ledger: measureInput([]),
    });
    const text = renderTextReport(report);
    expect(text).not.toContain(secretMarker);
    expect(text).not.toContain(AWARENESS_WAKE_INSTRUCTION.slice(0, 40));
    expect(JSON.stringify(report)).not.toContain(secretMarker);
  });
});

// ------------------------------------------------------------------
// Windowing helper
// ------------------------------------------------------------------

describe('windowTurns', () => {
  it('keeps turns whose opening user message is inside [since, until)', () => {
    const turns = [
      makeTurn({ startedAt: '2026-09-30T23:59:59.999Z', role: 'gru', label: 'owner-turn', turnClass: 'owner' }),
      makeTurn({ startedAt: SINCE, role: 'gru', label: 'owner-turn', turnClass: 'owner' }),
      makeTurn({ startedAt: UNTIL, role: 'gru', label: 'owner-turn', turnClass: 'owner' }),
    ];
    expect(windowTurns(turns, SINCE, UNTIL)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// CLI plumbing (real files, real ledger schema, no live instance)
// ------------------------------------------------------------------

describe('yield-report CLI', () => {
  it('parses flags strictly and requires ISO timestamps', () => {
    expect(parseArgs(['--since', SINCE, '--json'])).toEqual({ since: SINCE, until: null, dataDir: null, json: true });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--since'])).toThrow(/requires a value/);
    expect(() => requireIso('not-a-date', '--since')).toThrow(/ISO timestamp/);
    expect(() => requireIso('2026', '--since')).toThrow(/ISO timestamp/);
    expect(() => requireIso('2026-09-29', '--since')).toThrow(/ISO timestamp/);
    expect(requireIso('2026-09-29T02:00:00+02:00', '--since')).toBe('2026-09-29T00:00:00.000Z');
    expect(requireIso('2026-09-29T00:00:00Z', '--since')).toBe('2026-09-29T00:00:00.000Z');
  });

  it('lists role session files, skipping backups, and reads a fixture ledger read-only', async () => {
    const dataDir = tmpDir('gru-yield-cli-');
    const gruDir = join(dataDir, 'sessions', 'gru');
    const backupsDir = join(dataDir, 'sessions', 'gru', 'backups');
    const silasDir = join(dataDir, 'sessions', 'silas');
    mkdirSync(gruDir, { recursive: true });
    mkdirSync(backupsDir, { recursive: true });
    mkdirSync(silasDir, { recursive: true });
    writeFileSync(join(gruDir, 's1.jsonl'), `${userLine(SINCE, gruWakeText)}\n${assistantLine({ cost: 1.5 })}\n`);
    // A backup duplicate that must never be counted twice.
    writeFileSync(join(backupsDir, 'dup.jsonl'), `${userLine(SINCE, gruWakeText)}\n${assistantLine({ cost: 999 })}\n`);
    const sweepPrompt = sweepPromptWithDigest({ deliveredWithoutPr: ['job-a'] });
    writeFileSync(
      join(silasDir, 's2.jsonl'),
      [
        userLine('2026-10-01T01:00:00.000Z', sweepPrompt),
        assistantLine({ cost: 0.5 }),
        userLine('2026-10-01T02:00:00.000Z', sweepPrompt),
        assistantLine({ cost: 0.5 }),
      ].join('\n') + '\n',
    );
    // A delivery-role session: discovery must include it in delivery cost.
    const minionDir = join(dataDir, 'sessions', 'minion');
    mkdirSync(minionDir, { recursive: true });
    const briefing = renderMinionBriefing({
      jobId: 'j-9',
      repoName: 'repo',
      branch: 'gru/j-9',
      worktreePath: '/fixture/wt9',
      sha: 'feedface',
      briefing: 'carry the crate',
    });
    writeFileSync(
      join(minionDir, 'm1.jsonl'),
      `${userLine('2026-10-01T04:00:00.000Z', briefing)}\n${assistantLine({ cost: 3 })}\n`,
    );

    const files = listSessionFiles(dataDir);
    expect(files.map((file) => `${file.role}:${file.path.split('/').pop()}`)).toEqual([
      'gru:s1.jsonl',
      'minion:m1.jsonl',
      'silas:s2.jsonl',
    ]);

    // Real ledger schema via LedgerDb, then deterministic-history inserts.
    const db = new LedgerDb(dataDir);
    try {
      const insertEvent = db.handle.prepare('INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, NULL, NULL, NULL, ?)');
      insertEvent.run('2026-10-01T01:00:00.000Z', 'silas.wake', JSON.stringify({ trigger: 'sweep', actionable: 1 }));
      insertEvent.run('2026-10-01T01:30:00.000Z', 'silas.directive-sent', JSON.stringify({ request_id: 'r1' }));
      insertEvent.run('2026-10-01T02:00:00.000Z', 'gru.wake', JSON.stringify({ notification_ids: ['conflict-1'], count: 1, mode: 'action-required' }));
      insertEvent.run('2026-10-01T02:20:00.000Z', 'notification.resolved', JSON.stringify({ id: 'conflict-1', by: 'gru' }));
      insertEvent.run('2026-10-01T03:00:00.000Z', 'job.status', JSON.stringify({ from: 'in-review', to: 'merged' }));
      db.handle.prepare('UPDATE events SET job_id = ? WHERE kind = ?').run('finished-1', 'job.status');
      db.handle
        .prepare('INSERT INTO notifications (id, ts, kind, routing, severity, title) VALUES (?, ?, ?, ?, ?, ?)')
        .run('conflict-1', '2026-10-01T01:59:00.000Z', 'github.pr-conflict:job-x', 'action', 'error', 'conflict');
      db.handle
        .prepare('INSERT INTO jobs (id, repo, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('finished-1', 'repo', 'title', 'merged', '2026-09-30T00:00:00.000Z', '2026-10-01T03:00:00.000Z');

      const ledger = readLedger(dataDir);
      expect(ledger.events.map((e) => e.kind).sort()).toEqual(['gru.wake', 'job.status', 'notification.resolved', 'silas.directive-sent', 'silas.wake']);
      expect(ledger.notifications).toEqual([{ id: 'conflict-1', kind: 'github.pr-conflict:job-x' }]);
      expect(ledger.jobs).toEqual([{ id: 'finished-1', createdAt: '2026-09-30T00:00:00.000Z' }]);

      // End to end: JSON report over the fixture data dir.
      const writes: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await runYieldReport(
          ['--since', SINCE, '--until', UNTIL, '--data-dir', dataDir, '--json'],
          () => new Date(UNTIL),
        );
        expect(code).toBe(0);
      } finally {
        process.stdout.write = originalWrite;
      }
      const report = JSON.parse(writes.join('')) as Parameters<typeof renderTextReport>[0];
      expect(report.usage.total.costUsd).toBeCloseTo(5.5); // gru 1.5 + silas 1.0 + minion 3.0; backup dup (999) never counted
      expect(report.usage.byClass.delivery.costUsd).toBeCloseTo(3); // the minion briefing is delivery work
      expect(report.usage.byModel.some((model) => model.costUsd > 0)).toBe(true);
      expect(report.m0.costPerFinishedUsd).toBeCloseTo(5.5);
      expect(report.silasYield.wakes).toBe(1);
      expect(report.silasYield.wakesWithAction).toBe(1);
      expect(report.gruYield.wakes).toBe(1);
      expect(report.gruWakeCauses.conflictOnlyWakes).toBe(1);
      expect(report.digestStability).toEqual({ sweeps: 2, stable: 1, share: 1 });
      expect(report.m0.finishedJobs).toBe(1);
      expect(report.m0.wipTotal).toBe(0);

      // Text rendering of the same report stays paste-safe.
      const text = renderTextReport(report);
      expect(text).not.toContain('Silas ops wake');
      const silasParsed = await parseSessionLines('silas', [
        userLine('2026-10-01T01:00:00.000Z', sweepPrompt),
        assistantLine({}),
      ]);
      expect(sweepSignaturesOf(silasParsed.turns)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('fails loud when --since is missing or the ledger cannot be opened', async () => {
    await expect(runYieldReport([], () => new Date(UNTIL))).rejects.toThrow(/--since/);
    await expect(
      runYieldReport(['--since', SINCE, '--data-dir', join(tmpDir('gru-yield-empty-'), 'missing')], () => new Date(UNTIL)),
    ).rejects.toThrow(/cannot open ledger/);
  });

  it('rejects an inverted window', async () => {
    const dataDir = tmpDir('gru-yield-inverted-');
    mkdirSync(dataDir, { recursive: true });
    await expect(
      runYieldReport(['--since', UNTIL, '--until', SINCE, '--data-dir', dataDir], () => new Date(UNTIL)),
    ).rejects.toThrow(/--since must be before --until/);
  });
});
