import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { SessionStore } from '../src/sessions/store.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { ClaudeCodeHandle } from '../src/runtime/claude-adapter.js';
import { inspectDirectiveCheckpoint } from '../src/runtime/directive-checkpoint.js';
import { configPathFor, loadConfig } from '../src/config.js';
import { DirectiveProgressService, executeAcceptedDirective } from '../src/dispatch/directive-progress.js';
import type { PromptOptions } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import { admitNativeDirectiveFixture } from './helpers/directive-native-fixture.js';

/**
 * #542: a directive or re-brief turn may request a verification run through
 * the scheduler and keep working. The in-turn tool fence does not count the
 * turn's OWN run (requested after the turn's native admission, on its job and
 * lane) as a blocker; everything else still fences. These run the real Claude
 * adapter over the CLI double through the production executor.
 */

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const UNSETTLED = 'unsettled verification run(s) hold the lane';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 3000; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Frame = Record<string, unknown>;
const readFrames = (file: string): Frame[] => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Frame);
const toolResults = (file: string): { is_error?: boolean; content?: unknown }[] => readFrames(file)
  .flatMap((frame) => ((frame['message'] as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; is_error?: boolean; content?: unknown }[])
  .filter((part) => part.type === 'tool_result');
const hostAllowed = (file: string): boolean => readFrames(file).some((frame) => frame['type'] === 'control_response' && JSON.stringify(frame).includes('"behavior":"allow"'));
const guardRefusals = (file: string): string[] => {
  const journal = `${file}.producers.jsonl`;
  return !existsSync(journal) ? [] : readFileSync(journal, 'utf8').trim().split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { state?: string; reason?: string }).filter((row) => row.state === 'guard-refused').map((row) => row.reason ?? '');
};

const JOB = 'own-run-job';

/** A Claude Code minion's job: the real adapter over the CLI double, through
 * the real registry and the production executor. The prompt is held at the
 * CLI's echo until `release` exists, so the test can move the ledger between
 * the turn's admission and its first tool request. */
async function scene(kind: 'directive' | 'rebrief' = 'directive') {
  const dir = mkdtempSync(join(tmpdir(), 'gru-own-run-'));
  const repo = makeFixtureRepo('own-run');
  const home = mkdtempSync(join(tmpdir(), 'gru-own-run-home-'));
  const release = join(dir, 'release');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'), ledger);
  ledger.addJob({ id: JOB, repo: 'fixture', title: 'own run fence', briefing: 'approved original contract' });
  ledger.setJobStatus(JOB, 'working');
  ledger.setJobPr(JOB, 'https://example.test/pull/542');
  const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: JOB });
  if (ledger.getWorktree(lane.id) === null) ledger.registerWorktree(lane);
  writeFileSync(configPathFor(home), `workspace_root = "${dir}"\n[runtimes]\ndefault = "claude-code"\n`);
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const registry = new RuntimeRegistry({ config, store, claude: { binary: DOUBLE, reviewSettingsFile: join(home, 'absent-review-settings.json') } });
  registry.onAgentEvent((envelope) => {
    if (envelope.phase === 'event' && envelope.event?.type === 'state' && ledger.getAgent(envelope.agentId) !== null) ledger.setAgentState(envelope.agentId, envelope.event.state);
  });
  const first = await registry.spawn('minion', { cwd: lane.path, agentId: 'own-run-minion' });
  ledger.registerAgent({ id: first.id, role: 'minion', jobId: JOB, sessionFile: first.sessionFile, parentage: 'top-level' });
  await registry.disposeHandle(first);
  ledger.setAgentState(first.id, 'disposed');
  const deps = { ledger, registry, worktrees, notifications, signal: new AbortController().signal, pendingProducerBlockers: () => [] };
  cleanups.push(async () => {
    await registry.dispose(); store.dispose(); db.close(); repo.cleanup();
    rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  });
  const accept = (requestId: string, text: string) => kind === 'rebrief'
    ? ledger.beginRebriefIntent({ jobId: JOB, requestId, note: text, holder: 'gru' }).record
    : ledger.beginDirectiveIntent({ jobId: JOB, requestId, directive: text, holder: 'gru' }).record;
  const intent = accept('own-run-request', `held:${release} tool:Read finish the approved scope`);
  return { ledger, lane, deps, intent, release, dir, accept, sessionFile: (): string => ledger.getDirective(intent.requestId)!.nativeTarget!.sessionFile };
}
type Scene = Awaited<ReturnType<typeof scene>>;

interface Run {
  readonly runId: string;
  readonly pid: number;
  /** The run's `cwd`; the lane's own path unless a test says otherwise. */
  readonly cwd?: string;
  /** Record the scheduler's pid for the run and its lane process row. */
  readonly process?: boolean;
  readonly evidence?: 'registry' | 'cwd';
  readonly settled?: boolean;
}

/** What the scheduler and the verify server record for one run (see
 * `verify/scheduler.ts` and `verify/server.ts`'s lane process tracking). */
function requestRun(s: Scene, { runId, pid, cwd = s.lane.path, process = true, evidence = 'registry', settled = false }: Run): void {
  const base = { run_id: runId, scope: 'full', command: 'npm test', cwd };
  s.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: JOB, payload: { ...base, request_id: `${runId}-request`, head: 'a'.repeat(40), dedupe_key: runId } });
  if (process) {
    s.ledger.appendCustomEvent({ kind: 'verification.process-started', jobId: JOB, payload: { ...base, pid, process_command: '/bin/sh -c npm test', step_command: 'npm test', step_index: 0, step_count: 1, sha: 'a'.repeat(40) } });
    s.ledger.recordWorktreeProcesses({ worktreeId: s.lane.id, processes: [{ pid, command: '/bin/sh -c npm test', evidence }], state: 'live' });
  }
  if (settled) s.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: JOB, payload: { run_id: runId } });
}

function settleRun(s: Scene, runId: string, pid: number): void {
  s.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: JOB, payload: { run_id: runId } });
  s.ledger.recordWorktreeProcesses({ worktreeId: s.lane.id, processes: [{ pid, command: '/bin/sh -c npm test', evidence: 'registry' }], state: 'killed' });
}

/** The turn: admitted at the CLI's echo (held there), `moveLedger` runs between
 * that admission and the turn's first tool request, then the CLI is released. */
async function takeTurn(s: Scene, moveLedger: () => void): Promise<void> {
  const running = executeAcceptedDirective(s.deps, s.intent.requestId);
  await until(() => s.ledger.getDirective(s.intent.requestId)?.nativeBinding?.userEntryId != null, 'the CLI echo to admit the turn');
  moveLedger();
  writeFileSync(s.release, '');
  await running;
}

describe('#542 the in-turn tool fence and the turn\'s own verification run', () => {
  it('a directive turn keeps working while its own run is unsettled; closeout still waits for the run', async () => {
    const s = await scene();
    let admissionSeq = 0;
    await takeTurn(s, () => {
      admissionSeq = s.ledger.getDirective(s.intent.requestId)!.admissionSeq!;
      requestRun(s, { runId: 'own-run', pid: 41001 });
    });
    const file = s.sessionFile();
    // The run postdates the admission, is unsettled, and its pid row is live: both blockers stand.
    expect(s.ledger.latestJobEvent(JOB, 'verification.requested')!.seq).toBeGreaterThan(admissionSeq);
    expect(s.ledger.hasUnsettledVerificationRun(JOB)).toBe(true);
    expect(s.ledger.listWorktreeProcesses(s.lane.id)).toEqual([expect.objectContaining({ pid: 41001, state: 'live', evidence: 'registry' })]);
    // The tool after the request was allowed and ran; the turn was not ended.
    expect(guardRefusals(file)).toEqual([]);
    expect(hostAllowed(file)).toBe(true);
    expect(toolResults(file)).toEqual([expect.objectContaining({ content: 'ok' })]);
    expect(toolResults(file)[0]!.is_error).not.toBe(true);
    expect(inspectDirectiveCheckpoint(file, s.ledger.directiveTurnIdentity(s.intent.requestId))).toMatchObject({ state: 'terminal', ok: true });
    // Closeout is unchanged: the run still holds the request open, by name.
    const held = s.ledger.getDirective(s.intent.requestId)!;
    expect(held.state).toBe('admitted');
    expect(held.failReason).toContain(UNSETTLED);
    // Once the run settles, normal progress settles the request.
    settleRun(s, 'own-run', 41001);
    const service = new DirectiveProgressService(s.deps);
    try { service.reconsider(); await service.settled(); } finally { await service.dispose(); }
    expect(s.ledger.getDirective(s.intent.requestId)?.state).toBe('settled');
  });

  it('a re-brief turn keeps working while its own run is unsettled', async () => {
    const s = await scene('rebrief');
    await takeTurn(s, () => requestRun(s, { runId: 'own-run', pid: 41002 }));
    const file = s.sessionFile();
    expect(s.ledger.hasUnsettledVerificationRun(JOB)).toBe(true);
    expect(guardRefusals(file)).toEqual([]);
    expect(hostAllowed(file)).toBe(true);
    expect(toolResults(file)).toEqual([expect.objectContaining({ content: 'ok' })]);
  });

  it('the process row of a run that settled while its row is still live is the turn\'s own too', async () => {
    const s = await scene();
    await takeTurn(s, () => requestRun(s, { runId: 'own-run', pid: 41003, settled: true }));
    const file = s.sessionFile();
    expect(s.ledger.hasUnsettledVerificationRun(JOB)).toBe(false);
    expect(s.ledger.listWorktreeProcesses(s.lane.id)).toEqual([expect.objectContaining({ pid: 41003, state: 'live' })]);
    expect(guardRefusals(file)).toEqual([]);
    expect(toolResults(file)).toEqual([expect.objectContaining({ content: 'ok' })]);
  });

  it('a run already unsettled when the turn was admitted still refuses its tool and ends the turn', async () => {
    const s = await scene();
    const realPrompt = ClaudeCodeHandle.prototype.prompt;
    // The run lands after the last pre-admission check and before the CLI's echo binds the admission.
    vi.spyOn(ClaudeCodeHandle.prototype, 'prompt').mockImplementation(function (this: ClaudeCodeHandle, text: string, options?: PromptOptions) {
      const directive = options?.directive;
      if (directive === undefined) return realPrompt.call(this, text, options);
      let seeded = false;
      return realPrompt.call(this, text, { ...options, directive: { ...directive, beforeAdmission: () => {
        directive.beforeAdmission();
        if (!seeded) { seeded = true; requestRun(s, { runId: 'earlier-run', pid: 41004 }); }
      } } });
    });
    await takeTurn(s, () => {});
    const file = s.sessionFile();
    const admissionSeq = s.ledger.getDirective(s.intent.requestId)!.admissionSeq!;
    expect(s.ledger.latestJobEvent(JOB, 'verification.requested')!.seq).toBeLessThan(admissionSeq);
    expect(guardRefusals(file)).toEqual([expect.stringContaining(UNSETTLED)]);
    expect(guardRefusals(file)[0]).toContain(`live lane process(es): ${s.lane.id} pid 41004`);
    expect(hostAllowed(file)).toBe(false);
    expect(toolResults(file)).toEqual([expect.objectContaining({ is_error: true })]);
    expect(inspectDirectiveCheckpoint(file, s.ledger.directiveTurnIdentity(s.intent.requestId))).not.toMatchObject({ state: 'terminal', ok: true });
  });

  it('a lane process the run did not start still refuses the tool; the run\'s own pid is not named', async () => {
    const s = await scene();
    await takeTurn(s, () => {
      requestRun(s, { runId: 'own-run', pid: 41005 });
      s.ledger.recordWorktreeProcesses({ worktreeId: s.lane.id, processes: [{ pid: 41006, command: 'node server.js', evidence: 'registry' }], state: 'live' });
    });
    const refusal = guardRefusals(s.sessionFile());
    expect(refusal).toEqual([expect.stringContaining(`live lane process(es): ${s.lane.id} pid 41006`)]);
    expect(refusal[0]).not.toContain('41005');
    expect(refusal[0]).not.toContain(UNSETTLED);
    expect(hostAllowed(s.sessionFile())).toBe(false);
  });

  it('a row for the run\'s pid that is not the registry\'s own row is not exempt', async () => {
    const s = await scene();
    await takeTurn(s, () => requestRun(s, { runId: 'own-run', pid: 41007, evidence: 'cwd' }));
    expect(guardRefusals(s.sessionFile())).toEqual([expect.stringContaining(`live lane process(es): ${s.lane.id} pid 41007`)]);
    expect(hostAllowed(s.sessionFile())).toBe(false);
  });

  it('a run requested for another working directory is not the turn\'s own', async () => {
    const s = await scene();
    await takeTurn(s, () => requestRun(s, { runId: 'elsewhere-run', pid: 41008, cwd: join(s.dir, 'another-checkout'), process: false }));
    expect(guardRefusals(s.sessionFile())).toEqual([expect.stringContaining(UNSETTLED)]);
    expect(hostAllowed(s.sessionFile())).toBe(false);
  });

  it('a started run with no scheduler request on the job is not the turn\'s own, whatever else the turn requested', async () => {
    const s = await scene();
    await takeTurn(s, () => {
      requestRun(s, { runId: 'own-run', pid: 41009 });
      s.ledger.appendCustomEvent({ kind: 'verification.started', jobId: JOB, payload: { run_id: 'unattributed-run' } });
    });
    expect(guardRefusals(s.sessionFile())).toEqual([expect.stringContaining(UNSETTLED)]);
    expect(hostAllowed(s.sessionFile())).toBe(false);
  });

  it('a later request\'s admission is still refused by a run that postdates an earlier request\'s admission', async () => {
    const s = await scene();
    await takeTurn(s, () => {});
    expect(s.ledger.getDirective(s.intent.requestId)?.state).toBe('settled');
    const earlierAdmission = s.ledger.getDirective(s.intent.requestId)!.admissionSeq!;
    // A run the earlier turn could have called its own, left unsettled when it ended.
    requestRun(s, { runId: 'left-behind-run', pid: 41011 });
    expect(s.ledger.latestJobEvent(JOB, 'verification.requested')!.seq).toBeGreaterThan(earlierAdmission);
    const later = s.accept('later-request', 'tool:Read the next approved step');
    await executeAcceptedDirective(s.deps, later.requestId);
    const refused = s.ledger.getDirective(later.requestId)!;
    expect(refused.nativeBinding).toBeNull();
    expect(refused.state).not.toBe('settled');
    expect(refused.failReason).toContain(UNSETTLED);
    expect(refused.failReason).toContain(`live lane process(es): ${s.lane.id} pid 41011`);
  });
});

describe('#542 the ledger takes the exemption only from an admitted request\'s validated live producer', () => {
  it('the flag exempts nothing without a producer, and nothing before the request is admitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-own-run-ledger-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new LedgerDb(dir);
    cleanups.push(() => db.close());
    const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    const repo = makeFixtureRepo('own-run-ledger');
    cleanups.push(() => repo.cleanup());
    const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'), ledger);
    ledger.addJob({ id: JOB, repo: 'fixture', title: 'own run ledger', briefing: 'approved original contract' });
    ledger.setJobStatus(JOB, 'working');
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: JOB });
    if (ledger.getWorktree(lane.id) === null) ledger.registerWorktree(lane);
    const request = ledger.beginDirectiveIntent({ jobId: JOB, requestId: 'ledger-request', directive: 'finish', holder: 'gru' }).record;
    const run = (): void => {
      ledger.appendCustomEvent({ kind: 'verification.requested', jobId: JOB, payload: { run_id: 'late-run', scope: 'full', cwd: lane.path, request_id: 'late-request' } });
      ledger.appendCustomEvent({ kind: 'verification.process-started', jobId: JOB, payload: { run_id: 'late-run', pid: 41010, cwd: lane.path } });
      ledger.recordWorktreeProcesses({ worktreeId: lane.id, processes: [{ pid: 41010, command: 'sh', evidence: 'registry' }], state: 'live' });
    };
    const blockers = (): string => ledger.directiveProgressBlockers(request.requestId, lane.id, undefined, undefined, undefined, true).join('; ');
    // Not yet admitted: a run requested now is nobody's own.
    run();
    expect(blockers()).toContain(UNSETTLED);
    expect(blockers()).toContain(`live lane process(es): ${lane.id} pid 41010`);
    // Admitted afterwards, but with no validated live producer behind the flag: still fenced.
    admitNativeDirectiveFixture(ledger, request.requestId, 'ledger-minion', join(dir, 'native.jsonl'));
    expect(ledger.getDirective(request.requestId)!.admissionSeq!).toBeGreaterThan(ledger.latestJobEvent(JOB, 'verification.requested')!.seq);
    expect(blockers()).toContain(UNSETTLED);
    expect(blockers()).toContain('pid 41010');
  });
});
