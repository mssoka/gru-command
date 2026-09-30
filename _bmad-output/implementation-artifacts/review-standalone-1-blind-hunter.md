Conduct a review of CONTENT.
Look for what's missing, not only what's wrong.
Compute your finding floor N from the diff file's size: N = min(floor(sqrt(kB) + 1), 10), where kB is the file's size in kilobytes. State the arithmetic in one line, then find at least N issues to fix or improve.
Output a Markdown list of findings only — no severity, priority, or ranking.
If the content is empty, stop and say so.
If you have zero findings, re-check and keep thinking; do not stop with an empty list.

CONTENT: the unified diff below (inlined from _bmad-output/implementation-artifacts/foryou-diff-for-review.patch; base df9fe01e87913c5f2ad47219ddc2f838eca6d045 → current lane HEAD). That diff is the content under review.

Do not invoke any skill, and do not spawn subagents of your own — you are the reviewer. Return your findings as text in your final message; do not route them through any findings-reporting tool the host may offer.

===== BEGIN DIFF =====
diff --git a/docs/BOARD.md b/docs/BOARD.md
index e7dee39..6d615f4 100644
--- a/docs/BOARD.md
+++ b/docs/BOARD.md
@@ -89,14 +89,40 @@ and — as the last-attached handler — terminates unclaimed upgrade paths
   hold the page and chat overlays via the Gru FAB (right drawer, dimmed
   board behind); below 900px the rail stacks under the board and the FAB
   opens a bottom sheet.
-- **Dashboard:** **attention bands** — NEEDS GRU → IN FLIGHT → SETTLED →
+- **Dashboard:** a permanent **FOR YOU** owner band sits ABOVE the job
+  bands (owner approval 2026-09-28): the owner's pending obligations —
+  unacked `needs-owner` rows (Ack, with consequence copy that names what
+  the ack does and does NOT do — a quota/breaker ack re-arms the worker
+  but never clears code/test/review holds) plus the server-projected,
+  evidence-bound **ready PRs** (see below). Viewing completes nothing:
+  the header count is owed actions, not unseen rows; the count only
+  moves on an authoritative ack (any device) or confirmed merged/closed
+  state. Rows are deterministic (newest first, stable
+  `owner-ack:{id}`/`owner-pr:{jobId}` ids), focus survives snapshot
+  re-renders, and the older tail hides behind a `+N older pending`
+  expander — the engine already merges EVERY unacked needs-owner row
+  into the snapshot, so no pending obligation is lost to the bounded
+  feed. The PR action is **OPEN PR** (external https link only) — a
+  link click is never a merge; readiness is projected SERVER-side
+  (`ownerPrs` on the snapshot) from the conjunction of durable exact-head
+  facts: `in-review` job + recorded PR, a `github.branch-state`
+  observation whose `pr_url` matches the recorded PR with
+  `merged:false` + `mergeable_state:clean`, CI observed **green at that
+  exact sha**, and the job's NEWEST review round `verdict-posted` /
+  `approved` with its frozen `targetRef` equal to that sha. Anything
+  missing, stale, moved, dirty, blocked, pending/failed, or
+  changes-requested renders no row (fail closed — no heuristic).
+  Known limitation (deliberate): GitHub-native review approvals beyond
+  `mergeable_state` are not separately projected; the Perkins verdict is
+  represented by the head-bound approved round. Then the **attention
+  bands** — NEEDS GRU → IN FLIGHT → SETTLED →
   COLD, recency inside each band — rendered as full-width **dense rows**
   (line 1: dot + title + status chip; line 2: repo + branch + heist/minion
   ages + PR link), with sticky band headers carrying counts and hairline
   dividers. Failing rows (blocked/error, aborted round, errored lenses
   without a verdict) are tinted with a left alert accent. NEEDS GRU is
   always visible (empty = calm “nothing needs Gru”); FOR YOU belongs only
-  to the owner notification band. SETTLED is a rolling
+  to the owner band. SETTLED is a rolling
   window (latest 10 + `+K older settled`, session-expanded; concluded
   jobs render their last round quiescent — no stale blocker pills). Click
   a row to disclose lane + rounds (v3 collapse, persisted per job).
@@ -119,7 +145,10 @@ and — as the last-attached handler — terminates unclaimed upgrade paths
   (all pending needs-owner rows, even older than the bounded latest feed:
   owner-only decisions and stops whose ack re-arms supervision), NEEDS GRU
   (all pending machine rows, including those older than the recent feed;
-  it wakes Gru once and refuses human Ack), and FEED (FYI rows). A machine
+  it wakes Gru once and refuses human Ack), and FEED (FYI rows). The bell
+  is the alert/history surface: it shares the SAME authoritative rows as
+  the board's permanent FOR YOU band (no second state machine); opening
+  it never completes an obligation. A machine
   alert left unresolved 30 minutes after delivery opens a separate
   owner-only follow-up in FOR YOU; Gru's later disposition resolves it. The badge and live
   toasts serve needs-owner only; every displayed row earns a shown receipt
diff --git a/docs/UI.md b/docs/UI.md
index d1fc785..f43910c 100644
--- a/docs/UI.md
+++ b/docs/UI.md
@@ -284,6 +284,15 @@ sight).
 
 ### Attention bands (v4 → v6: dense rows)
 
+A permanent **FOR YOU** owner band (owner approval 2026-09-28) sits
+ABOVE the job bands — pending owner acks (with honest consequence copy)
+and evidence-bound ready PRs (OPEN PR, external https link only) —
+see [BOARD.md](./BOARD.md) for the semantics and the fail-closed
+readiness rule. Its empty state is the calm clear state (an empty owner
+list is healthy); its rows are keyboard-focusable and a snapshot
+re-render preserves focus (stable action ids) and never toasts or rings
+a chime.
+
 Jobs bucket NEEDS GRU → IN FLIGHT → SETTLED → COLD (recency inside each
 band; see [BOARD.md](./BOARD.md)). v6 renders every band as a full-width
 **dense row list**, not a card grid: line 1 = status dot + title +
diff --git a/src/board/engine.ts b/src/board/engine.ts
index 56e3a6d..56999ee 100644
--- a/src/board/engine.ts
+++ b/src/board/engine.ts
@@ -7,6 +7,7 @@ import type { AgentSupervisionView } from '../supervision/supervisor.js';
 import type { DecisionRuntimeStatus } from '../decisions/runtime.js';
 import type { DeployDriftView } from './deploy-drift.js';
 import type { VerificationQueueView } from '../verify/scheduler.js';
+import { ownerReadyPr, readBranchEvidence, type OwnerPrView } from './owner-actions.js';
 import {
   DEFAULT_LENSES,
   LedgerApi,
@@ -158,6 +159,11 @@ export interface BoardSnapshot {
   readonly verify: VerificationQueueView | null;
   /** Self-healing session stats (null until its producer exists). */
   readonly selfHeal: SelfHealView | null;
+  /** FOR YOU (owner approval 2026-09-28): PRs with exact-head evidence
+   * that they are genuinely ready for the owner — approved head-bound
+   * review round + clean mergeable state + green CI at the same sha.
+   * Fail-closed: absent readiness renders no row, never a guess. */
+  readonly ownerPrs: readonly OwnerPrView[];
 }
 
 /** Agent-rail ordering: the standing crew first, workers after. */
@@ -443,9 +449,25 @@ export class BoardEngine {
       silas: this.silasView(),
       verify: this.verifyQueue(),
       selfHeal: this.selfHeal(),
+      ownerPrs: this.ownerPrs(repos),
     };
   }
 
+  /** The FOR YOU PR projection: one authoritative, evidence-bound ready
+   * list over the snapshot's own job views (deterministic job-id order —
+   * a stable row order across pushes). Only in-review jobs with a PR
+   * reach the evidence read — the cheap gates run first. */
+  private ownerPrs(
+    repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[],
+  ): readonly OwnerPrView[] {
+    return repos
+      .flatMap((repo) => repo.jobs)
+      .filter((job) => job.status === 'in-review' && job.prUrl !== null)
+      .map((job) => ownerReadyPr(job, readBranchEvidence(this.ledger, job.id)))
+      .filter((row): row is OwnerPrView => row !== null)
+      .sort((left, right) => left.jobId.localeCompare(right.jobId));
+  }
+
   /** Silas ops health from the durable event stream: newest wake + today's
    * reconciliations (state-correction events, not the wake itself). */
   private silasView(): SilasView {
diff --git a/src/board/owner-actions.ts b/src/board/owner-actions.ts
new file mode 100644
index 0000000..1f60491
--- /dev/null
+++ b/src/board/owner-actions.ts
@@ -0,0 +1,126 @@
+/**
+ * Owner-action projection (FOR YOU board band, owner approval 2026-09-28):
+ * the ONE evidence-bound derivation of "this PR is genuinely ready for
+ * the owner to review/merge" — computed server-side from durable ledger
+ * state so every surface (board band, bell, future consumers) shares one
+ * authoritative answer instead of a browser heuristic.
+ *
+ * Readiness is a CONJUNCTION of exact-head facts, each already durable:
+ *   - the job is `in-review` with a recorded PR URL (https only);
+ *   - a `github.branch-state` observation exists for the job whose
+ *     `pr_url` is EXACTLY the recorded PR (no ambiguity about which pull
+ *     the evidence describes);
+ *   - that observation says the PR is NOT merged and mergeable_state is
+ *     `clean` (not dirty/blocked/unknown/unstable — conflicts and
+ *     required-gate blocks fail closed);
+ *   - CI was observed GREEN at exactly the branch-state sha (a carried
+ *     forward conclusion for a moved head never qualifies);
+ *   - the job's NEWEST review round is `verdict-posted` with verdict
+ *     `approved` and its frozen `targetRef` equals that same sha — an
+ *     approved round for an older head, an aborted or pending newer
+ *     round, or `changes-requested` never qualifies.
+ *
+ * Anything missing, stale, moved, or failing renders NO row (fail
+ * closed). Nothing here infers authority from PR titles, check names, or
+ * notification prose: display data is never execution authority.
+ */
+
+import {
+  BRANCH_STATE_EVENT,
+  readBranchState,
+  type CiState,
+  type GitHubPollLedger,
+  type NormalizedBranchState,
+} from '../dispatch/github-poll.js';
+
+/** The ledger slice the evidence reader needs (the engine's LedgerApi
+ * satisfies it; tests inject a stub). */
+export type BranchEvidenceLedger = Pick<GitHubPollLedger, 'latestJobEvent'>;
+
+/** One durable branch-state observation plus WHEN it was recorded — the
+ * projection surfaces the stamp so the row can age honestly. */
+export interface BranchEvidence {
+  readonly state: NormalizedBranchState;
+  readonly checkedAt: string;
+}
+
+/** Read the job's newest branch-state evidence; null when none is
+ * recorded (no PR observation ever landed for this job). */
+export function readBranchEvidence(ledger: BranchEvidenceLedger, jobId: string): BranchEvidence | null {
+  const event = ledger.latestJobEvent(jobId, BRANCH_STATE_EVENT);
+  if (event === null) return null;
+  const state = readBranchState(ledger, jobId);
+  // An event whose payload cannot parse back is not evidence — fail
+  // closed (the poll re-observes on its next tick anyway).
+  if (state === null) return null;
+  return { state, checkedAt: event.ts };
+}
+
+/** The job slice the readiness rule consumes (JobView satisfies it; the
+ * shape is structural so tests build plain objects). */
+export interface OwnerPrJob {
+  readonly id: string;
+  readonly repo: string;
+  readonly title: string;
+  readonly status: string;
+  readonly prUrl: string | null;
+  readonly rounds: readonly {
+    readonly status: string;
+    readonly verdict: string | null;
+    readonly targetRef: string | null;
+  }[];
+}
+
+/** One owner-ready PR row (the snapshot's `ownerPrs` entry). */
+export interface OwnerPrView {
+  /** Stable row/action id: `owner-pr:{jobId}`. */
+  readonly id: string;
+  readonly jobId: string;
+  readonly jobTitle: string;
+  readonly repo: string;
+  /** https PR URL — the OPEN PR target, never an in-app merge. */
+  readonly prUrl: string;
+  /** The exact head sha every piece of evidence is bound to. */
+  readonly sha: string;
+  /** ISO stamp of the branch-state observation the row rests on. */
+  readonly checkedAt: string;
+}
+
+/** Only https URLs may become an OPEN PR link (fail closed otherwise). */
+export function isSafeHttpsUrl(url: string): boolean {
+  try {
+    return new URL(url).protocol === 'https:';
+  } catch {
+    return false;
+  }
+}
+
+/** CI counts as green-at-head only when observed at exactly that sha. */
+function greenAtHead(ci: CiState | null, sha: string): boolean {
+  return ci !== null && ci.sha === sha && ci.status === 'green';
+}
+
+/**
+ * The one readiness gate. Returns the row when EVERY condition holds,
+ * else null — a missing row is a fail-closed "not ready", never an
+ * error. Callers render nothing rather than guessing.
+ */
+export function ownerReadyPr(job: OwnerPrJob, evidence: BranchEvidence | null): OwnerPrView | null {
+  if (job.status !== 'in-review') return null; // blocked/parked/working = holds or not staged
+  const prUrl = job.prUrl;
+  if (prUrl === null || !isSafeHttpsUrl(prUrl)) return null;
+  if (evidence === null) return null; // no durable PR observation — fail closed
+  const { state, checkedAt } = evidence;
+  if (state.prUrl === null || state.prUrl !== prUrl) return null; // evidence describes another PR
+  if (state.merged) return null; // settled: only confirmed state clears
+  const sha = state.sha;
+  if (sha === null || sha === '') return null;
+  if (state.mergeableState !== 'clean') return null; // dirty/blocked/unknown/unstable
+  if (!greenAtHead(state.ci, sha)) return null; // CI pending/failed/unobserved/moved head
+  const round = job.rounds.at(-1) ?? null;
+  if (round === null) return null;
+  if (round.status !== 'verdict-posted' || round.verdict !== 'approved' || round.targetRef !== sha) {
+    return null; // no head-bound approval as the newest verdict
+  }
+  return { id: `owner-pr:${job.id}`, jobId: job.id, jobTitle: job.title, repo: job.repo, prUrl, sha, checkedAt };
+}
diff --git a/test/board-engine.test.ts b/test/board-engine.test.ts
index ec19e3a..ccaa7fd 100644
--- a/test/board-engine.test.ts
+++ b/test/board-engine.test.ts
@@ -496,3 +496,128 @@ describe('board engine — liveness-first rail and job trackers', () => {
     expect(engine.snapshot().wakes.count).toBe(2);
   });
 });
+
+describe('board engine — FOR YOU owner-PR projection on the snapshot', () => {
+  function fresh(): { api: LedgerApi; bus: EventBus; engine: BoardEngine } {
+    const db = new LedgerDb(tmpDir());
+    const bus = new EventBus();
+    const api = new LedgerApi(db.handle, { bus });
+    return { api, bus, engine: new BoardEngine({ ledger: api, bus }) };
+  }
+
+  const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
+  const PR_URL = 'https://github.com/example/demo/pull/7';
+
+  /** Stage one job exactly as the real flow would: in-review + PR + a
+   * head-bound approved round + a matching branch-state observation. */
+  function stageReadyJob(api: LedgerApi, id: string, sha: string = SHA): void {
+    const job = api.addJob({ id, repo: 'demo', title: `Heist ${id}` });
+    api.setJobPr(id, PR_URL);
+    // The legal staging path: dispatched → working → in-review (a PR on
+    // record is exactly what moves a lane into review).
+    api.setJobStatus(id, 'working');
+    api.setJobStatus(id, 'in-review');
+    const round = api.addRound({ jobId: id, targetRef: sha });
+    api.setRoundStatus(round.id, 'live');
+    api.setRoundVerdict(round.id, 'approved');
+    api.appendCustomEvent({
+      kind: 'github.branch-state',
+      jobId: id,
+      payload: {
+        repo: 'example/demo',
+        branch: `gru/${id}`,
+        sha,
+        merged: false,
+        mergeable_state: 'clean',
+        pr_number: 7,
+        pr_url: PR_URL,
+        merge_commit_sha: null,
+        ci: { sha, status: 'green', signature: '', failures: [], checks: ['ci'] },
+      },
+    });
+    void job;
+  }
+
+  it('ships one ownerPrs row for the exact-head ready job (stable id, job order)', () => {
+    const { api, engine } = fresh();
+    stageReadyJob(api, 'job-b');
+    stageReadyJob(api, 'job-a');
+    const snap = engine.snapshot();
+    expect(snap.ownerPrs.map((row) => row.id)).toEqual(['owner-pr:job-a', 'owner-pr:job-b']);
+    expect(snap.ownerPrs[0]).toMatchObject({ jobId: 'job-a', prUrl: PR_URL, sha: SHA });
+  });
+
+  it('drops the row when the head moves after the approval (stale CI/verdict at the old sha)', () => {
+    const { api, engine } = fresh();
+    stageReadyJob(api, 'job-moved', SHA);
+    api.appendCustomEvent({
+      kind: 'github.branch-state',
+      jobId: 'job-moved',
+      payload: {
+        repo: 'example/demo',
+        branch: 'gru/job-moved',
+        sha: 'ffff0000aaaa1111bbbb2222cccc3333dddd4444',
+        merged: false,
+        mergeable_state: 'clean',
+        pr_number: 7,
+        pr_url: PR_URL,
+        merge_commit_sha: null,
+        ci: null,
+      },
+    });
+    expect(engine.snapshot().ownerPrs).toEqual([]);
+  });
+
+  it('drops the row when the job takes a hold (blocked) or a newer round is changes-requested', () => {
+    const { api, engine } = fresh();
+    stageReadyJob(api, 'job-hold');
+    api.setJobStatus('job-hold', 'blocked');
+    expect(engine.snapshot().ownerPrs).toEqual([]);
+
+    stageReadyJob(api, 'job-rejected');
+    const round = api.addRound({ jobId: 'job-rejected', targetRef: SHA });
+    api.setRoundStatus(round.id, 'live');
+    api.setRoundVerdict(round.id, 'changes-requested');
+    expect(engine.snapshot().ownerPrs).toEqual([]);
+  });
+
+  it('settles the row only on confirmed merged state, never on a link click', () => {
+    const { api, engine } = fresh();
+    stageReadyJob(api, 'job-merged');
+    api.appendCustomEvent({
+      kind: 'github.branch-state',
+      jobId: 'job-merged',
+      payload: {
+        repo: 'example/demo',
+        branch: 'gru/job-merged',
+        sha: SHA,
+        merged: true,
+        mergeable_state: 'clean',
+        pr_number: 7,
+        pr_url: PR_URL,
+        merge_commit_sha: 'abcd0000abcd0000abcd0000abcd0000abcd0000',
+        ci: { sha: SHA, status: 'green', signature: '', failures: [], checks: ['ci'] },
+      },
+    });
+    expect(engine.snapshot().ownerPrs).toEqual([]);
+  });
+
+  it('keeps an old pending owner stop AND a fresh ownerPrs row in one snapshot (distinct classes coexist)', () => {
+    const { api, engine } = fresh();
+    stageReadyJob(api, 'job-ready');
+    api.recordNotification({
+      id: 'old-owner-stop',
+      kind: 'supervision.breaker',
+      routing: 'needs-owner',
+      severity: 'info',
+      title: 'Owner-only re-arm',
+    });
+    for (let i = 0; i < 35; i += 1) {
+      api.recordNotification({ id: `feed-${i}`, kind: 'noise', routing: 'fyi', severity: 'info', title: `Noise ${i}` });
+    }
+    const snap = engine.snapshot();
+    expect(snap.unackedNeedsOwner).toBe(1);
+    expect(snap.notifications.find((row) => row.id === 'old-owner-stop')).toMatchObject({ ackedAt: null });
+    expect(snap.ownerPrs.map((row) => row.jobId)).toEqual(['job-ready']);
+  });
+});
diff --git a/test/owner-actions.test.ts b/test/owner-actions.test.ts
new file mode 100644
index 0000000..1d7901a
--- /dev/null
+++ b/test/owner-actions.test.ts
@@ -0,0 +1,177 @@
+import { mkdtempSync, rmSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { afterAll, beforeAll, describe, expect, it } from 'vitest';
+import { EventBus } from '../src/events/bus.js';
+import { LedgerApi } from '../src/ledger/api.js';
+import { LedgerDb } from '../src/ledger/db.js';
+import { BRANCH_STATE_EVENT, branchStatePayload, type CiState, type NormalizedBranchState, type RepoRef } from '../src/dispatch/github-poll.js';
+import {
+  isSafeHttpsUrl,
+  ownerReadyPr,
+  readBranchEvidence,
+  type BranchEvidence,
+  type OwnerPrJob,
+} from '../src/board/owner-actions.js';
+
+const cleanupDirs: string[] = [];
+afterAll(() => {
+  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
+});
+
+function tmpDir(): string {
+  const dir = mkdtempSync(join(tmpdir(), 'gru-command-owner-actions-'));
+  cleanupDirs.push(dir);
+  return dir;
+}
+
+const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
+const OTHER_SHA = 'ffff0000aaaa1111bbbb2222cccc3333dddd4444';
+const PR_URL = 'https://github.com/example/demo/pull/7';
+
+function greenCi(sha: string): CiState {
+  return { sha, status: 'green', signature: '', failures: [], checks: ['ci'] };
+}
+
+/** A branch-state event exactly as github-poll writes it. */
+function branchEvent(jobId: string, state: NormalizedBranchState) {
+  const lane = {
+    jobId,
+    repo: { host: 'github.com', owner: 'example', repo: 'demo' } as RepoRef,
+    branch: `gru/${jobId}`,
+    prNumber: state.prNumber,
+    prUrl: state.prUrl,
+  };
+  return { kind: BRANCH_STATE_EVENT, jobId: lane.jobId, payload: branchStatePayload(lane, state) };
+}
+
+function branchState(overrides: Partial<NormalizedBranchState> = {}): NormalizedBranchState {
+  return {
+    sha: SHA,
+    merged: false,
+    mergeableState: 'clean',
+    ci: greenCi(SHA),
+    prNumber: 7,
+    prUrl: PR_URL,
+    mergeCommitSha: null,
+    ...overrides,
+  };
+}
+
+function evidence(overrides: Partial<NormalizedBranchState> = {}): BranchEvidence {
+  return { state: branchState(overrides), checkedAt: '2026-09-28T10:00:00.000Z' };
+}
+
+function job(overrides: Partial<OwnerPrJob> = {}): OwnerPrJob {
+  return {
+    id: 'job-ready',
+    repo: 'demo',
+    title: 'Ready heist',
+    status: 'in-review',
+    prUrl: PR_URL,
+    rounds: [{ status: 'verdict-posted', verdict: 'approved', targetRef: SHA }],
+    ...overrides,
+  };
+}
+
+describe('owner-action projection — fail-closed readiness gate', () => {
+  it('qualifies the exact conjunction: in-review + matching PR + clean + green CI at the exact sha + head-bound approved round', () => {
+    const row = ownerReadyPr(job(), evidence());
+    expect(row).toEqual({
+      id: 'owner-pr:job-ready',
+      jobId: 'job-ready',
+      jobTitle: 'Ready heist',
+      repo: 'demo',
+      prUrl: PR_URL,
+      sha: SHA,
+      checkedAt: '2026-09-28T10:00:00.000Z',
+    });
+  });
+
+  const notReady: readonly (readonly [string, OwnerPrJob, BranchEvidence | null])[] = [
+    ['job is not in-review (hold)', job({ status: 'blocked' }), evidence()],
+    ['job has no recorded PR', job({ prUrl: null }), evidence()],
+    ['prUrl is not https', job({ prUrl: 'http://insecure.example/pr' }), evidence()],
+    ['no branch-state evidence at all', job(), null],
+    ['evidence describes a different PR', job(), evidence({ prUrl: 'https://github.com/example/demo/pull/9' })],
+    ['PR already merged', job(), evidence({ merged: true })],
+    ['head sha missing', job(), evidence({ sha: null })],
+    ['mergeable dirty (conflicts)', job(), evidence({ mergeableState: 'dirty' })],
+    ['mergeable blocked (required gate)', job(), evidence({ mergeableState: 'blocked' })],
+    ['mergeable unknown', job(), evidence({ mergeableState: null })],
+    ['mergeable unstable', job(), evidence({ mergeableState: 'unstable' })],
+    ['CI unobserved', job(), evidence({ ci: null })],
+    ['CI pending', job(), evidence({ ci: { sha: SHA, status: 'pending', signature: '', failures: [], checks: [] } })],
+    ['CI failed', job(), evidence({ ci: { sha: SHA, status: 'failed', signature: 'ci|lint', failures: [{ name: 'ci', conclusion: 'failure', url: null }], checks: [] } })],
+    ['CI green but at an older sha (head moved)', job(), evidence({ sha: OTHER_SHA, ci: greenCi(SHA) })],
+    ['no review rounds', job({ rounds: [] }), evidence()],
+    ['newest round not verdict-posted', job({ rounds: [{ status: 'live', verdict: null, targetRef: SHA }] }), evidence()],
+    ['newest round changes-requested', job({ rounds: [{ status: 'verdict-posted', verdict: 'changes-requested', targetRef: SHA }] }), evidence()],
+    ['approval bound to an older head', job({ rounds: [{ status: 'verdict-posted', verdict: 'approved', targetRef: OTHER_SHA }] }), evidence()],
+  ];
+  for (const [name, jobInput, ev] of notReady) {
+    it(`renders NO ready row when: ${name}`, () => {
+      expect(ownerReadyPr(jobInput, ev)).toBeNull();
+    });
+  }
+
+  it('an approved round followed by a newer aborted round fails closed (newest verdict must be the approval)', () => {
+    const jobInput = job({
+      rounds: [
+        { status: 'verdict-posted', verdict: 'approved', targetRef: SHA },
+        { status: 'aborted', verdict: null, targetRef: null },
+      ],
+    });
+    expect(ownerReadyPr(jobInput, evidence())).toBeNull();
+  });
+
+  it('a re-approved round at the moved head qualifies again (head-change invalidation is positional, not permanent)', () => {
+    const jobInput = job({
+      rounds: [
+        { status: 'verdict-posted', verdict: 'approved', targetRef: SHA },
+        { status: 'aborted', verdict: null, targetRef: null },
+        { status: 'verdict-posted', verdict: 'approved', targetRef: OTHER_SHA },
+      ],
+    });
+    const row = ownerReadyPr(jobInput, evidence({ sha: OTHER_SHA, ci: greenCi(OTHER_SHA) }));
+    expect(row?.sha).toBe(OTHER_SHA);
+  });
+
+  it('isSafeHttpsUrl accepts only https URLs', () => {
+    expect(isSafeHttpsUrl(PR_URL)).toBe(true);
+    expect(isSafeHttpsUrl('http://github.com/x')).toBe(false);
+    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
+    expect(isSafeHttpsUrl('not a url')).toBe(false);
+    expect(isSafeHttpsUrl('')).toBe(false);
+  });
+});
+
+describe('owner-action projection — evidence reader over the durable ledger', () => {
+  let api: LedgerApi;
+
+  beforeAll(() => {
+    const db = new LedgerDb(tmpDir());
+    api = new LedgerApi(db.handle, { bus: new EventBus() });
+  });
+
+  it('reads the newest branch-state event through the poll\'s own parser (no second parser drifts)', () => {
+    api.addJob({ id: 'job-evidence', repo: 'demo', title: 'Evidence' });
+    api.appendCustomEvent(branchEvent('job-evidence', branchState({ sha: OTHER_SHA })));
+    api.appendCustomEvent(branchEvent('job-evidence', branchState()));
+    const ev = readBranchEvidence(api, 'job-evidence');
+    expect(ev?.state.sha).toBe(SHA);
+    expect(ev?.state.mergeableState).toBe('clean');
+    expect(typeof ev?.checkedAt).toBe('string');
+  });
+
+  it('returns null evidence when no branch-state event exists (never a guess)', () => {
+    api.addJob({ id: 'job-silent', repo: 'demo', title: 'Silent' });
+    expect(readBranchEvidence(api, 'job-silent')).toBeNull();
+  });
+
+  it('returns null evidence for a malformed payload (fail closed, the poll re-observes)', () => {
+    api.addJob({ id: 'job-mangled', repo: 'demo', title: 'Mangled' });
+    api.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-mangled', payload: 'not-an-object' });
+    expect(readBranchEvidence(api, 'job-mangled')).toBeNull();
+  });
+});
diff --git a/web/index.html b/web/index.html
index b6e68f3..69541fd 100644
--- a/web/index.html
+++ b/web/index.html
@@ -145,6 +145,10 @@
 
       <section id="board-view" class="board-view" hidden>
         <div class="board-main">
+          <!-- FOR YOU (owner approval 2026-09-28): the permanent owner-action
+               band — pending acks + evidence-bound ready PRs — above the
+               machine bands. Rendered by BoardView.renderOwnerActions. -->
+          <section id="board-owner" class="board-band board-band--owner" hidden aria-labelledby="board-owner-head"></section>
           <div id="board-jobs" class="board-jobs"></div>
         </div>
         <div id="notification-panel" class="pp-card notification-panel" hidden>
diff --git a/web/mock/server.ts b/web/mock/server.ts
index ca2b9bd..d89431c 100644
--- a/web/mock/server.ts
+++ b/web/mock/server.ts
@@ -362,6 +362,21 @@ function sampleSnapshot(): unknown {
     },
     unackedActionRequired: 1,
     unackedNeedsOwner: 1,
+    // FOR YOU (owner approval 2026-09-28): one evidence-bound ready PR.
+    // Generic sample data only — the readiness story is exact-head
+    // (approved round + clean + green CI at the same sha); the row's
+    // action is OPEN PR (external), never an in-app merge.
+    ownerPrs: [
+      {
+        id: 'owner-pr:demo-api-payment-fix',
+        jobId: 'demo-api-payment-fix',
+        jobTitle: 'Fix the payment retry loop',
+        repo: 'demo-api',
+        prUrl: 'https://example.invalid/pr/41',
+        sha: '5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a',
+        checkedAt: new Date(Date.now() - 60_000).toISOString(),
+      },
+    ],
     wakes: { count: 2, lastAt: new Date(Date.now() - 180_000).toISOString() },
     build: {
       buildRev: 'abc1234def5678abc1234def5678abc1234def56',
diff --git a/web/src/lib/board-protocol.test.ts b/web/src/lib/board-protocol.test.ts
index d6bb4ac..7177df7 100644
--- a/web/src/lib/board-protocol.test.ts
+++ b/web/src/lib/board-protocol.test.ts
@@ -172,6 +172,36 @@ describe('board server-frame validator', () => {
     }
   });
 
+
+  it('FOR YOU ownerPrs: absent/null tolerated (pre-upgrade servers), well-formed accepted, malformed rejected', () => {
+    expect(isValidSnapshot(snapshot())).toBe(true);
+    const nullPrs = { ...snapshot(), ownerPrs: null } as unknown;
+    expect(isValidSnapshot(nullPrs)).toBe(true);
+
+    const ready = {
+      id: 'owner-pr:job-1',
+      jobId: 'job-1',
+      jobTitle: 'Ready heist',
+      repo: 'demo-repo',
+      prUrl: 'https://github.com/example/demo/pull/7',
+      sha: 'a'.repeat(40),
+      checkedAt: '2026-01-01T00:00:00.000Z',
+    };
+    expect(isValidSnapshot({ ...snapshot(), ownerPrs: [ready] } as unknown)).toBe(true);
+
+    // Readiness is server authority: a malformed row never reaches the band.
+    for (const broken of [
+      { ...ready, id: '' },
+      { ...ready, jobId: 7 },
+      { ...ready, sha: null },
+      { ...ready, checkedAt: 12 },
+      { ...ready, prUrl: 'javascript:alert(1)' },
+    ]) {
+      expect(isValidSnapshot({ ...snapshot(), ownerPrs: [broken] } as unknown), JSON.stringify(broken)).toBe(false);
+    }
+    expect(isValidSnapshot({ ...snapshot(), ownerPrs: { not: 'an array' } } as unknown)).toBe(false);
+  });
+
   it('accepts prState present, null, or absent; rejects junk states', () => {
     for (const prState of ['open', 'conflicting', 'merged', null, undefined]) {
       const candidate = snapshot();
diff --git a/web/src/lib/board-protocol.ts b/web/src/lib/board-protocol.ts
index 1fdcc12..fce23c9 100644
--- a/web/src/lib/board-protocol.ts
+++ b/web/src/lib/board-protocol.ts
@@ -148,6 +148,24 @@ export interface SelfHealView {
   readonly since: string | null;
 }
 
+/** FOR YOU (owner approval 2026-09-28): one PR genuinely ready for the
+ * owner — the SERVER-computed, evidence-bound projection (approved
+ * head-bound review round + clean mergeable state + green CI at the
+ * exact head). The browser never re-derives readiness. */
+export interface OwnerPrView {
+  /** Stable row/action id: `owner-pr:{jobId}`. */
+  readonly id: string;
+  readonly jobId: string;
+  readonly jobTitle: string;
+  readonly repo: string;
+  /** https PR URL — the OPEN PR target, never an in-app merge. */
+  readonly prUrl: string;
+  /** The exact head sha every piece of evidence is bound to. */
+  readonly sha: string;
+  /** ISO stamp of the branch-state observation the row rests on. */
+  readonly checkedAt: string;
+}
+
 export interface BoardSnapshot {
   readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
   readonly agents: readonly AgentView[];
@@ -164,6 +182,9 @@ export interface BoardSnapshot {
   readonly silas?: SilasView | null;
   readonly verify?: VerifyQueueView | null;
   readonly selfHeal?: SelfHealView | null;
+  /** FOR YOU PR rows (owner approval 2026-09-28); absent on pre-upgrade
+  * servers (validator tolerates; the band renders ack rows only). */
+  readonly ownerPrs?: readonly OwnerPrView[] | null;
 }
 
 export interface TranscriptInfo {
@@ -361,6 +382,29 @@ function isSelfHealView(value: unknown): value is SelfHealView {
   );
 }
 
+function isOwnerPrView(value: unknown): value is OwnerPrView {
+  if (
+    !isRecord(value) ||
+    typeof value.id !== 'string' || value.id === '' ||
+    typeof value.jobId !== 'string' || value.jobId === '' ||
+    typeof value.jobTitle !== 'string' ||
+    typeof value.repo !== 'string' ||
+    typeof value.prUrl !== 'string' ||
+    typeof value.sha !== 'string' || value.sha === '' ||
+    typeof value.checkedAt !== 'string'
+  ) {
+    return false;
+  }
+  // OPEN PR targets are https only — a non-https prUrl can never render a
+  // link, so it fails closed at the validator, the projection, AND the
+  // render (three guards, one rule).
+  try {
+    return new URL(value.prUrl).protocol === 'https:';
+  } catch {
+    return false;
+  }
+}
+
 function isWakesView(value: unknown): boolean {
   return (
     isRecord(value) &&
@@ -394,6 +438,10 @@ export function isValidSnapshot(value: unknown): value is BoardSnapshot {
   if (value.silas !== undefined && value.silas !== null && !isSilasView(value.silas)) return false;
   if (value.verify !== undefined && value.verify !== null && !isVerifyQueueView(value.verify)) return false;
   if (value.selfHeal !== undefined && value.selfHeal !== null && !isSelfHealView(value.selfHeal)) return false;
+  // FOR YOU PR rows: absent on pre-upgrade servers (tolerated), but a
+  // present block must match its shape — readiness is server authority.
+  if (value.ownerPrs !== undefined && value.ownerPrs !== null && !Array.isArray(value.ownerPrs)) return false;
+  if (Array.isArray(value.ownerPrs) && !value.ownerPrs.every(isOwnerPrView)) return false;
   const agentsOk = value.agents.every(
     (agent) =>
       isRecord(agent) &&
diff --git a/web/src/lib/owner-band.test.ts b/web/src/lib/owner-band.test.ts
new file mode 100644
index 0000000..ad3f0c7
--- /dev/null
+++ b/web/src/lib/owner-band.test.ts
@@ -0,0 +1,175 @@
+import { describe, expect, it } from 'vitest';
+import type { BoardSnapshot, NotificationView, OwnerPrView } from './board-protocol.js';
+import {
+  OWNER_WINDOW_SIZE,
+  ackConsequence,
+  ownerPendingCount,
+  ownerRows,
+  ownerWindow,
+  safePrUrl,
+} from './owner-band.js';
+
+function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
+  return {
+    id,
+    ts: `2026-09-28T00:00:${String(10 + Number(id.slice(-2))).padStart(2, '0')}.000Z`,
+    kind: 'test.notice',
+    routing: 'fyi',
+    severity: 'info',
+    title: `Notice ${id}`,
+    detail: null,
+    agentId: null,
+    shownAt: null,
+    ackedAt: null,
+    resolvedAt: null,
+    resolvedBy: null,
+    ...overrides,
+  };
+}
+
+function pr(jobId: string, overrides: Partial<OwnerPrView> = {}): OwnerPrView {
+  return {
+    id: `owner-pr:${jobId}`,
+    jobId,
+    jobTitle: `Heist ${jobId}`,
+    repo: 'demo',
+    prUrl: 'https://github.com/example/demo/pull/7',
+    sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
+    checkedAt: '2026-09-28T00:05:00.000Z',
+    ...overrides,
+  };
+}
+
+function snapshot(options: { notifications?: readonly NotificationView[]; ownerPrs?: readonly OwnerPrView[] } = {}): BoardSnapshot {
+  return {
+    repos: [],
+    agents: [],
+    notifications: options.notifications ?? [],
+    decisions: {
+      enabled: false,
+      status: 'disabled',
+      reason: 'disabled',
+      model: '~typesafe/jev-latest',
+      endpoint: 'https://openrouter.ai/api/alpha/decisions',
+      credentialPresent: false,
+      credentialSource: 'none',
+      checkedAt: null,
+      incarnation: 'test',
+      generation: 0,
+    },
+    unackedActionRequired: 0,
+    unackedNeedsOwner: 0,
+    wakes: { count: 0, lastAt: null },
+    ownerPrs: options.ownerPrs,
+  };
+}
+
+describe('owner-band row model', () => {
+  it('collects ONLY unacked, unresolved needs-owner rows — machine rows, acked rows and resolved rows never enter', () => {
+    const rows = ownerRows(
+      snapshot({
+        notifications: [
+          notification('owner', { routing: 'needs-owner' }),
+          notification('machine', { routing: 'action-required' }),
+          notification('seen-ack', { routing: 'needs-owner', shownAt: '2026-09-28T00:00:00.000Z' }),
+          notification('acked', { routing: 'needs-owner', ackedAt: '2026-09-28T00:00:30.000Z' }),
+          notification('resolved', { routing: 'needs-owner', resolvedAt: '2026-09-28T00:00:30.000Z' }),
+          notification('fyi', { routing: 'fyi' }),
+        ],
+      }),
+    );
+    expect(rows.map((row) => row.actionId)).toEqual(['owner-ack:owner', 'owner-ack:seen-ack']);
+  });
+
+  it('merges ack rows and PR rows newest-first with stable id tiebreak (deterministic across renders)', () => {
+    const rows = ownerRows(
+      snapshot({
+        notifications: [notification('older', { routing: 'needs-owner', ts: '2026-09-28T00:00:00.000Z' })],
+        ownerPrs: [pr('job-a'), pr('job-b', { checkedAt: '2026-09-27T00:00:00.000Z' })],
+      }),
+    );
+    expect(rows.map((row) => row.actionId)).toEqual([
+      'owner-pr:job-a', // 00:05 checkedAt — newest
+      'owner-ack:older', // 00:00 ack
+      'owner-pr:job-b', // yesterday
+    ]);
+  });
+
+  it('treats an identical ts as a deterministic tiebreak by action id (never feed order)', () => {
+    const rows = ownerRows(
+      snapshot({
+        notifications: [notification('z-row', { routing: 'needs-owner', ts: '2026-09-28T00:00:00.000Z' })],
+        ownerPrs: [pr('a-job', { checkedAt: '2026-09-28T00:00:00.000Z' })],
+      }),
+    );
+    expect(rows.map((row) => row.actionId)).toEqual(['owner-ack:z-row', 'owner-pr:a-job']);
+  });
+
+  it('ownerPendingCount counts owed actions, never unseen rows (shownAt does not reduce it)', () => {
+    const snap = snapshot({
+      notifications: [
+        notification('a', { routing: 'needs-owner', shownAt: '2026-09-28T00:00:00.000Z' }),
+        notification('b', { routing: 'needs-owner' }),
+      ],
+      ownerPrs: [pr('job-a')],
+    });
+    expect(ownerPendingCount(snap)).toBe(3);
+  });
+
+  it('absent ownerPrs (pre-upgrade server) degrades to ack rows only — no invented ready rows', () => {
+    const rows = ownerRows(snapshot({ notifications: [notification('owner', { routing: 'needs-owner' })] }));
+    expect(rows).toHaveLength(1);
+    expect(rows[0]!.kind).toBe('ack');
+  });
+
+  it('the expander window keeps every obligation reachable and never hides more than the tail', () => {
+    const many = ownerRows(
+      snapshot({
+        notifications: Array.from({ length: OWNER_WINDOW_SIZE + 3 }, (_, i) =>
+          notification(`n${String(i).padStart(2, '0')}`, { routing: 'needs-owner' }),
+        ),
+      }),
+    );
+    const collapsed = ownerWindow(many, false);
+    expect(collapsed.rows).toHaveLength(OWNER_WINDOW_SIZE);
+    expect(collapsed.hidden).toBe(3);
+    const expanded = ownerWindow(many, true);
+    expect(expanded.rows).toHaveLength(many.length);
+    expect(expanded.hidden).toBe(0);
+  });
+});
+
+describe('ack consequence copy — honest scope per kind, never parsed prose', () => {
+  it('quota walls and breakers: ack re-arms the worker and does NOT clear holds', () => {
+    const line = ackConsequence('supervision.provider-wall.agent-1.quota_exceeded');
+    expect(line).toContain('re-arms this worker');
+    expect(line).toContain('does NOT clear code/test/review holds');
+    expect(ackConsequence('supervision.breaker')).toBe(line);
+  });
+
+  it('degraded decisions: the ack is a sighting record, not a fix', () => {
+    expect(ackConsequence('decisions.degraded.timeout')).toContain('stays degraded');
+  });
+
+  it('sweep confirmations and port squats name the manual step', () => {
+    expect(ackConsequence('worktree-sweep-paused')).toContain('removal');
+    expect(ackConsequence('port-squat')).toContain('Stop the foreign process');
+    expect(ackConsequence('roll-port-squat')).toContain('Stop the foreign process');
+  });
+
+  it('unknown kinds get the generic honest line (no fabricated semantics)', () => {
+    expect(ackConsequence('gru.owner-escalation')).toContain('does not by itself prove');
+    expect(ackConsequence('something.brand.new')).toContain('does not by itself prove');
+  });
+});
+
+describe('safePrUrl', () => {
+  it('accepts https and rejects everything else', () => {
+    expect(safePrUrl('https://github.com/x/y/pull/1')).toBe('https://github.com/x/y/pull/1');
+    expect(safePrUrl('http://github.com/x/y/pull/1')).toBeNull();
+    expect(safePrUrl('javascript:alert(1)')).toBeNull();
+    expect(safePrUrl('https://')).toBeNull(); // no host — never a real target
+    expect(safePrUrl('')).toBeNull();
+    expect(safePrUrl('github.com/x/y/pull/1')).toBeNull();
+  });
+});
diff --git a/web/src/lib/owner-band.ts b/web/src/lib/owner-band.ts
new file mode 100644
index 0000000..176fa69
--- /dev/null
+++ b/web/src/lib/owner-band.ts
@@ -0,0 +1,106 @@
+/**
+ * FOR YOU owner-band row model (owner approval 2026-09-28) — pure
+ * derivations so the band's honesty rules are testable without a DOM.
+ *
+ * The band renders ONE authoritative pending-owner list:
+ *   - ack rows: `needs-owner` notifications still unacked AND unresolved
+ *     (pending = action still owed; seen/opened never completes one);
+ *   - PR rows: the server-computed, evidence-bound `ownerPrs` projection
+ *     (the browser never re-derives merge readiness).
+ *
+ * Ordering is deterministic (newest first, action id tiebreak) and row
+ * ids are stable across renders (`owner-ack:{id}` / `owner-pr:{jobId}`)
+ * so focus, aria and tests address the same control before and after a
+ * snapshot push. No text-based dedupe, no grouping, no bulk actions.
+ */
+
+import type { BoardSnapshot, NotificationView, OwnerPrView } from './board-protocol.js';
+
+/** Consequence copy explains WHAT an ack does and does NOT do. Static
+ * per kind — never parsed out of notification prose (prose is display
+ * data, not execution authority). */
+export function ackConsequence(kind: string): string {
+  if (kind.startsWith('supervision.provider-wall.') || kind === 'supervision.breaker') {
+    return 'Ack re-arms this worker and resumes supervision — it does NOT clear code/test/review holds.';
+  }
+  if (kind.startsWith('decisions.degraded.')) {
+    return 'Ack records that you saw this; the system stays degraded until the credential or provider is fixed.';
+  }
+  if (kind === 'worktree-sweep-paused') {
+    return 'Ack confirms removal of the listed worktree — check nothing live is rooted there first.';
+  }
+  if (kind === 'port-squat' || kind === 'roll-port-squat') {
+    return 'Stop the foreign process yourself; ack only clears the notice.';
+  }
+  return 'Ack clears this notice from your queue; it does not by itself prove the underlying operation ran.';
+}
+
+export interface OwnerAckRow {
+  readonly kind: 'ack';
+  readonly actionId: string;
+  readonly ts: string;
+  readonly notification: NotificationView;
+  readonly consequence: string;
+}
+
+export interface OwnerPrRow {
+  readonly kind: 'pr';
+  readonly actionId: string;
+  readonly ts: string;
+  readonly pr: OwnerPrView;
+}
+
+export type OwnerRow = OwnerAckRow | OwnerPrRow;
+
+/** Pending owner obligations, newest first (id tiebreak). The snapshot's
+ * notification list already carries EVERY unacked needs-owner row — the
+ * 30-row feed window never truncates the owner queue. */
+export function ownerRows(snapshot: BoardSnapshot): readonly OwnerRow[] {
+  const rows: OwnerRow[] = [];
+  for (const notification of snapshot.notifications) {
+    if (notification.routing !== 'needs-owner') continue;
+    if (notification.ackedAt !== null || notification.resolvedAt !== null) continue;
+    rows.push({
+      kind: 'ack',
+      actionId: `owner-ack:${notification.id}`,
+      ts: notification.ts,
+      notification,
+      consequence: ackConsequence(notification.kind),
+    });
+  }
+  for (const pr of snapshot.ownerPrs ?? []) {
+    rows.push({ kind: 'pr', actionId: pr.id, ts: pr.checkedAt, pr });
+  }
+  return rows.sort((left, right) => right.ts.localeCompare(left.ts) || left.actionId.localeCompare(right.actionId));
+}
+
+/** The pending count shown in the band header — owed actions, not unseen
+ * rows. Opening the board or the bell never changes it. */
+export function ownerPendingCount(snapshot: BoardSnapshot): number {
+  return ownerRows(snapshot).length;
+}
+
+/** How many rows render before the "+N older" expander. Nothing is ever
+ * dropped — the older pending tail lives behind the expander. */
+export const OWNER_WINDOW_SIZE = 6;
+
+export interface OwnerWindowView {
+  readonly rows: readonly OwnerRow[];
+  readonly hidden: number;
+}
+
+export function ownerWindow(rows: readonly OwnerRow[], expanded: boolean, limit = OWNER_WINDOW_SIZE): OwnerWindowView {
+  if (expanded || rows.length <= limit) return { rows, hidden: 0 };
+  return { rows: rows.slice(0, limit), hidden: rows.length - limit };
+}
+
+/** OPEN PR targets: https only. A non-https prUrl renders no link (fail
+ * closed) — the server already refuses to project them, this is the
+ * browser-side guard against a malformed payload. */
+export function safePrUrl(url: string): string | null {
+  try {
+    return new URL(url).protocol === 'https:' ? url : null;
+  } catch {
+    return null;
+  }
+}
diff --git a/web/src/styles/components.css b/web/src/styles/components.css
index 33fbda8..f39bae7 100644
--- a/web/src/styles/components.css
+++ b/web/src/styles/components.css
@@ -1520,6 +1520,158 @@ body {
   transition: background 0.15s ease, color 0.15s ease;
 }
 
+/* ── FOR YOU (owner approval 2026-09-28): the permanent owner-action
+   band above the machine bands. Same band skeleton, owner accent;
+   rows are dense two-liners with the control on the right, hairline
+   dividers like the job rows — never a card grid. ───────────────── */
+.board-band--owner {
+  --band-accent: var(--rev);
+}
+
+.board-owner__rows {
+  display: grid;
+}
+
+.board-owner__row {
+  position: relative;
+  display: grid;
+  grid-template-columns: minmax(0, 1fr) auto;
+  grid-template-areas:
+    'title action'
+    'meta action'
+    'note action';
+  align-items: center;
+  column-gap: 12px;
+  padding: 8px 6px 9px;
+  border-bottom: 1px solid color-mix(in srgb, var(--line) 22%, transparent);
+}
+
+.board-owner__row:last-child {
+  border-bottom: 0;
+}
+
+/* Error-severity obligations keep the left alert accent (a stop is a
+   stop); info-severity owner asks stay calm. */
+.board-owner__row--error::before {
+  content: '';
+  position: absolute;
+  left: 0;
+  top: 6px;
+  bottom: 6px;
+  width: 4px;
+  border-radius: 999px;
+  background: var(--alert);
+}
+
+.board-owner__row--error {
+  padding-left: 12px;
+}
+
+.board-owner__row--pr {
+  padding-left: 12px;
+}
+
+.board-owner__row--pr::before {
+  content: '';
+  position: absolute;
+  left: 0;
+  top: 6px;
+  bottom: 6px;
+  width: 4px;
+  border-radius: 999px;
+  background: var(--done);
+}
+
+.board-owner__title {
+  grid-area: title;
+  font-weight: 800;
+  font-size: 13px;
+  overflow-wrap: anywhere;
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  flex-wrap: wrap;
+  min-width: 0;
+}
+
+.board-owner__ready {
+  flex: none;
+}
+
+.board-owner__meta {
+  grid-area: meta;
+  overflow-wrap: anywhere;
+}
+
+.board-owner__consequence {
+  grid-area: note;
+  color: var(--muted);
+  overflow-wrap: anywhere;
+}
+
+.board-owner__ack,
+.board-owner__open {
+  grid-area: action;
+  justify-self: end;
+  align-self: center;
+  flex: none;
+  font-size: 12px;
+  font-weight: 800;
+  padding: 5px 12px;
+  border-radius: 999px;
+  border: 2px solid var(--ink);
+  cursor: pointer;
+  white-space: nowrap;
+}
+
+.board-owner__ack {
+  margin-top: 0; /* reset the panel row's flow margin — this is a grid area */
+  background: var(--accent-soft, var(--soft));
+  color: var(--ink);
+}
+
+.board-owner__ack:disabled {
+  opacity: 0.6;
+  cursor: default;
+}
+
+.board-owner__open {
+  display: inline-flex;
+  align-items: center;
+  text-decoration: none;
+  background: var(--done);
+  color: var(--on-state);
+}
+
+.board-owner__open:hover {
+  filter: brightness(1.05);
+}
+
+.board-owner__nolink {
+  grid-area: action;
+  justify-self: end;
+}
+
+/* Narrow viewports: the control drops under the text instead of
+   squeezing it — no horizontal overflow, thumb-sized targets. */
+@media (max-width: 560px) {
+  .board-owner__row {
+    grid-template-columns: minmax(0, 1fr);
+    grid-template-areas:
+      'title'
+      'meta'
+      'note'
+      'action';
+    row-gap: 6px;
+  }
+
+  .board-owner__ack,
+  .board-owner__open,
+  .board-owner__nolink {
+    justify-self: start;
+  }
+}
+
 .board-band__more:hover {
   background: var(--soft);
   color: var(--ink);
diff --git a/web/src/ui/board.test.ts b/web/src/ui/board.test.ts
index 82556ba..98739a0 100644
--- a/web/src/ui/board.test.ts
+++ b/web/src/ui/board.test.ts
@@ -110,6 +110,7 @@ function snapshot(
     repos?: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
     unackedNeedsOwner?: number;
     wakes?: { readonly count: number; readonly lastAt: string | null };
+    ownerPrs?: NonNullable<BoardSnapshot['ownerPrs']>;
   } = {},
 ): BoardSnapshot {
   return {
@@ -136,6 +137,7 @@ function snapshot(
     selfHeal: options.selfHeal ?? null,
     unackedNeedsOwner: options.unackedNeedsOwner ?? 0,
     wakes: options.wakes ?? { count: 0, lastAt: null },
+    ownerPrs: options.ownerPrs,
   };
 }
 
@@ -146,6 +148,7 @@ function mountBoardDom(): void {
       <span id="board-unacked" hidden></span>
       <span id="board-wakes" hidden></span>
     </div>
+    <section id="board-owner" hidden></section>
     <div id="board-jobs"></div>
     <div id="board-agents"></div>
     <span id="rail-agents-count">0</span>
@@ -966,3 +969,182 @@ describe('board v6 — job status tones', () => {
     expect(row?.querySelector('.board-job__dot')?.className).toContain('board-job__dot--work');
   });
 });
+
+describe('FOR YOU owner band (permanent, top of board)', () => {
+  beforeEach(mountBoardDom);
+
+  function ownerPr(jobId: string, overrides: Partial<NonNullable<BoardSnapshot['ownerPrs']>[number]> = {}) {
+    return {
+      id: `owner-pr:${jobId}`,
+      jobId,
+      jobTitle: `Heist ${jobId}`,
+      repo: 'demo',
+      prUrl: 'https://github.com/example/demo/pull/7',
+      sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
+      checkedAt: '2026-01-01T00:05:00.000Z',
+      ...overrides,
+    };
+  }
+
+  function stubClient(ackResult: Promise<void> | Error = Promise.resolve()) {
+    return {
+      ackNotification: vi.fn(() => (ackResult instanceof Error ? Promise.reject(ackResult) : ackResult)),
+      markNotificationShown: vi.fn(() => Promise.resolve(true)),
+    } as unknown as import('../lib/board-client.js').BoardClient;
+  }
+
+  it('shows only the owner stop under FOR YOU with count; the machine incident stays in NEEDS GRU (bell), not the band', () => {
+    const view = new BoardView(() => {});
+    view.render(
+      snapshot({
+        notifications: [
+          notification('owner-stop', { routing: 'needs-owner', kind: 'supervision.breaker', severity: 'info' }),
+          notification('machine', { routing: 'action-required' }),
+        ],
+        unackedActionRequired: 1,
+        unackedNeedsOwner: 1,
+      }),
+    );
+    const band = document.getElementById('board-owner')!;
+    expect(band.hidden).toBe(false);
+    expect(band.querySelector('.board-band__label')?.textContent).toBe('FOR YOU');
+    expect(band.querySelector('.board-band__count')?.textContent).toBe('1 pending');
+    const actionIds = [...band.querySelectorAll('[data-action-id]')].map((node) => (node as HTMLElement).dataset.actionId);
+    expect(actionIds).toEqual(['owner-ack:owner-stop']);
+    // The machine row is in the bell panel's NEEDS GRU section, never in the band.
+    expect(document.getElementById('notification-list')?.textContent).toContain('Notice machine');
+    expect(band.textContent).not.toContain('Notice machine');
+    // The other board groups still render below the band.
+    expect(document.getElementById('board-jobs')!.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
+  });
+
+  it('an empty owner list is the calm clear state — never hidden, never an alarm', () => {
+    const view = new BoardView(() => {});
+    view.render(snapshot({ notifications: [] }));
+    const band = document.getElementById('board-owner')!;
+    expect(band.hidden).toBe(false);
+    expect(band.querySelector('.board-band__count')?.textContent).toBe('0 pending');
+    expect(band.querySelector('.board-band__clear-text')?.textContent).toBe('nothing needs you');
+  });
+
+  it('seen/opened does not reduce the pending count (only an authoritative ack closes a row)', () => {
+    const view = new BoardView(() => {});
+    const seen = notification('seen-stop', { routing: 'needs-owner', shownAt: '2026-01-01T00:00:00.000Z' });
+    view.render(snapshot({ notifications: [seen], unackedNeedsOwner: 1 }));
+    // Opening the bell panel marks seen but completes nothing.
+    (document.getElementById('notification-bell') as HTMLButtonElement).click();
+    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('1 pending');
+    view.render(snapshot({ notifications: [seen], unackedNeedsOwner: 1 }));
+    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('1 pending');
+    // The authoritative snapshot (ack from ANY device) is what closes it.
+    view.render(snapshot({ notifications: [{ ...seen, ackedAt: '2026-01-01T00:09:00.000Z' }], unackedNeedsOwner: 0 }));
+    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('0 pending');
+  });
+
+  it('ack click: optimistic pending state, stays pending on failure (control reverts), closes only on the authoritative snapshot', async () => {
+    const client = stubClient(new Error('network ambiguity'));
+    const view = new BoardView(() => {}, client);
+    const stop = notification('ack-me', { routing: 'needs-owner', kind: 'supervision.provider-wall.a1.quota_exceeded' });
+    view.render(snapshot({ notifications: [stop] }));
+    const band = document.getElementById('board-owner')!;
+    const button = band.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:ack-me"]')!;
+    // Honest consequence copy rides the row (quota ack scope).
+    expect(band.textContent).toContain('does NOT clear code/test/review holds');
+    button.click();
+    expect(button.textContent).toBe('acking…');
+    expect(button.disabled).toBe(true);
+    await Promise.resolve();
+    await Promise.resolve();
+    expect(client.ackNotification).toHaveBeenCalledWith('ack-me');
+    // Failed HTTP → the obligation stands and the control returns.
+    expect(button.textContent).toBe('Ack');
+    expect(button.disabled).toBe(false);
+    view.render(snapshot({ notifications: [stop] }));
+    expect(band.querySelector('[data-action-id="owner-ack:ack-me"]')).not.toBeNull();
+    // Success → STILL pending until the authoritative snapshot lands.
+    const okClient = stubClient();
+    const view2 = new BoardView(() => {}, okClient);
+    view2.render(snapshot({ notifications: [stop] }));
+    const button2 = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('.board-owner__ack')!;
+    button2.click();
+    await Promise.resolve();
+    await Promise.resolve();
+    expect(document.getElementById('board-owner')!.querySelector('[data-action-id="owner-ack:ack-me"]')).not.toBeNull();
+    view2.render(snapshot({ notifications: [{ ...stop, ackedAt: '2026-01-01T00:09:00.000Z' }] }));
+    expect(document.getElementById('board-owner')!.querySelector('[data-action-id="owner-ack:ack-me"]')).toBeNull();
+  });
+
+  it('ready PR row: affected heist + exact-head reason + OPEN PR external link; non-https URLs fail closed', () => {
+    const view = new BoardView(() => {});
+    view.render(snapshot({ ownerPrs: [ownerPr('job-ready')] }));
+    const band = document.getElementById('board-owner')!;
+    expect(band.querySelector('.board-band__count')?.textContent).toBe('1 pending');
+    const row = band.querySelector('.board-owner__row--pr')!;
+    expect(row.textContent).toContain('Heist job-ready');
+    expect(row.textContent).toContain('aaaa1111');
+    expect(row.textContent).toContain('CI green');
+    const link = row.querySelector<HTMLAnchorElement>('.board-owner__open');
+    expect(link?.href).toBe('https://github.com/example/demo/pull/7');
+    expect(link?.target).toBe('_blank');
+    expect(link?.rel).toContain('noreferrer');
+    // Fail closed on an unsafe URL: no link is fabricated.
+    view.render(snapshot({ ownerPrs: [ownerPr('bad-url', { prUrl: 'javascript:alert(1)' })] }));
+    const badRow = document.getElementById('board-owner')!.querySelectorAll('.board-owner__row--pr')[0]!;
+    expect(badRow.querySelector('a')).toBeNull();
+    expect(badRow.textContent).toContain('PR link unavailable');
+  });
+
+  it('older pending obligations stay reachable behind the +N older expander', () => {
+    const view = new BoardView(() => {});
+    const stops = Array.from({ length: 9 }, (_, i) =>
+      notification(`old-${String(i).padStart(2, '0')}`, { routing: 'needs-owner', ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z` }),
+    );
+    view.render(snapshot({ notifications: stops }));
+    const band = document.getElementById('board-owner')!;
+    expect(band.querySelectorAll('.board-owner__row')).toHaveLength(6);
+    const more = band.querySelector<HTMLButtonElement>('.board-band__more')!;
+    expect(more.textContent).toBe('+3 older pending');
+    more.click();
+    expect(document.getElementById('board-owner')!.querySelectorAll('.board-owner__row')).toHaveLength(9);
+  });
+
+  it('a snapshot re-render preserves focus on the same action and fires no toast', () => {
+    const toast = vi.fn();
+    const view = new BoardView(() => {});
+    view.setToastHandler(toast);
+    const stop = notification('focus-me', { routing: 'needs-owner' });
+    view.render(snapshot({ notifications: [stop] }));
+    const button = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:focus-me"]')!;
+    button.focus();
+    expect(document.activeElement).toBe(button);
+    // A refresh of the SAME data re-renders the band: no new arrival, so
+    // no toast — and the focused control keeps its place.
+    view.render(snapshot({ notifications: [stop] }));
+    expect(toast).not.toHaveBeenCalled();
+    const refocused = document.getElementById('board-owner')!.querySelector<HTMLElement>('[data-action-id="owner-ack:focus-me"]');
+    expect(document.activeElement).toBe(refocused);
+    expect((document.activeElement as HTMLElement)?.dataset.actionId).toBe('owner-ack:focus-me');
+  });
+
+  it('a visible band sends one web-board shown receipt per notification; a hidden band sends none', async () => {
+    const client = stubClient();
+    const stop = notification('show-me', { routing: 'needs-owner' });
+    const view = new BoardView(() => {}, client);
+    view.render(snapshot({ notifications: [stop] }));
+    // Visible band → receipt once; a re-render of the same row never repeats it.
+    view.render(snapshot({ notifications: [stop] }));
+    expect(client.markNotificationShown).toHaveBeenCalledTimes(1);
+    expect(client.markNotificationShown).toHaveBeenCalledWith('show-me', 'web-board');
+
+    // Hidden ancestor (pre-pairing board) → nothing was displayed.
+    const client2 = stubClient();
+    document.body.innerHTML = `<div hidden><section id="board-owner"></section></div>
+      <div id="chip-rail" hidden><span id="board-decisions"></span><span id="board-unacked" hidden></span><span id="board-wakes" hidden></span></div>
+      <div id="board-jobs"></div><div id="board-agents"></div><span id="rail-agents-count">0</span>
+      <button id="notification-bell"><span id="notification-badge">0</span></button>
+      <div id="notification-panel"><div id="notification-list"></div></div>`;
+    const view2 = new BoardView(() => {}, client2);
+    view2.render(snapshot({ notifications: [stop] }));
+    expect(client2.markNotificationShown).not.toHaveBeenCalled();
+  });
+});
diff --git a/web/src/ui/board.ts b/web/src/ui/board.ts
index 3928f9c..4d79784 100644
--- a/web/src/ui/board.ts
+++ b/web/src/ui/board.ts
@@ -42,6 +42,13 @@ import { railChips, type RailChip } from '../lib/board-rail.js';
 import { BOARD_WORDS, heistCount } from '../lib/board-vocabulary.js';
 import { formatAge } from '../lib/board-time.js';
 import { jobSignal, pluralCount, roundSummary, unackedByJob, type RoundSummary } from '../lib/board-signals.js';
+import {
+  ownerRows,
+  ownerWindow,
+  safePrUrl,
+  type OwnerAckRow,
+  type OwnerPrRow,
+} from '../lib/owner-band.js';
 
 /** Truthful lens progress for whole-PR rounds: show what actually ran —
  * including lenses that ran and failed — and name unused lenses instead of
@@ -83,6 +90,7 @@ export interface TranscriptOpenRequest {
 
 export class BoardView {
   private readonly mount: HTMLElement;
+  private readonly ownerMount: HTMLElement;
   private readonly chipRail: HTMLElement;
   private readonly agentsCount: HTMLElement;
   private readonly notificationBell: HTMLButtonElement;
@@ -127,6 +135,9 @@ export class BoardView {
   /** v5: job ids already on screen (new rows slide in; old ones do not). */
   private readonly knownJobIds = new Set<string>();
   private firstJobsRender = true;
+  /** FOR YOU: the older pending tail lives behind the expander
+   * (session-expanded, like the SETTLED window). */
+  private ownerExpanded = false;
 
   constructor(
     onOpenTranscript: (request: TranscriptOpenRequest) => void,
@@ -134,6 +145,7 @@ export class BoardView {
     collapseStorage: StorageLike | null = null,
   ) {
     this.mount = mustGet('board-jobs');
+    this.ownerMount = mustGet('board-owner');
     this.chipRail = mustGet('chip-rail');
     this.agentsCount = mustGet('rail-agents-count');
     this.notificationBell = mustGet<HTMLButtonElement>('notification-bell');
@@ -178,6 +190,7 @@ export class BoardView {
   render(snapshot: BoardSnapshot): void {
     const previous = this.snapshot;
     this.snapshot = snapshot;
+    this.renderOwnerActions(snapshot);
     this.renderRail(snapshot);
     this.renderJobs(snapshot);
     this.renderAgents(snapshot.agents);
@@ -185,6 +198,162 @@ export class BoardView {
     this.surfaceNewNotifications(previous, snapshot.notifications);
   }
 
+  // ------------------------------------------------------------------
+  // FOR YOU — the permanent owner-action band (owner approval 2026-09-28)
+  // ------------------------------------------------------------------
+
+  /** The owner's pending obligations, always at the top of the board:
+   * unacked needs-owner rows (Ack closes them on the authoritative
+   * snapshot) plus the server-projected, evidence-bound ready PRs (OPEN
+   * PR only — a link click never claims a merge). Viewing completes
+   * nothing: the count is owed actions, not unseen rows. */
+  private renderOwnerActions(snapshot: BoardSnapshot): void {
+    const mount = this.ownerMount;
+    const rows = ownerRows(snapshot);
+    // Focus preservation: a snapshot push re-renders the band; a focused
+    // control keeps its place (stable action ids make it the same
+    // control, not a lookalike).
+    const active = document.activeElement;
+    const focusId =
+      active instanceof HTMLElement && mount.contains(active)
+        ? active.dataset.actionId ?? null
+        : null;
+    const bandVisible = !mount.hidden && mount.closest('[hidden]') === null;
+    mount.replaceChildren();
+    const head = el('h2', 'board-band__head');
+    head.id = 'board-owner-head';
+    head.append(
+      el('span', 'board-band__label', 'FOR YOU'),
+      el('span', 'board-band__count lbl', `${rows.length} pending`),
+    );
+    mount.append(head);
+    mount.hidden = false;
+    if (rows.length === 0) {
+      // An empty owner list is healthy, not absence — the calm clear
+      // state NEEDS GRU uses (never hidden, never a false alarm).
+      const clear = el('div', 'board-band__clear board-owner__clear');
+      clear.append(
+        el('span', 'board-band__clear-mark', '✓'),
+        el('div', 'board-band__clear-text', 'nothing needs you'),
+        el('div', 'lbl board-band__clear-hint', 'pending owner actions land here'),
+      );
+      mount.append(clear);
+    } else {
+      const window = ownerWindow(rows, this.ownerExpanded);
+      const list = el('div', 'board-band__rows board-owner__rows');
+      for (const row of window.rows) {
+        if (row.kind === 'ack') {
+          list.append(this.ownerAckRow(row, bandVisible));
+        } else {
+          list.append(this.ownerPrRow(row));
+        }
+      }
+      mount.append(list);
+      if (window.hidden > 0) {
+        const more = el('button', 'board-band__more', `+${window.hidden} older pending`);
+        more.type = 'button';
+        more.setAttribute('aria-expanded', String(this.ownerExpanded));
+        more.addEventListener('click', () => {
+          this.ownerExpanded = true;
+          if (this.snapshot !== null) this.render(this.snapshot);
+        });
+        mount.append(more);
+      }
+    }
+    if (focusId !== null) this.refocusAction(focusId);
+  }
+
+  private refocusAction(actionId: string): void {
+    for (const node of this.ownerMount.querySelectorAll<HTMLElement>('[data-action-id]')) {
+      if (node.dataset.actionId === actionId) {
+        node.focus();
+        return;
+      }
+    }
+  }
+
+  /** One pending ack obligation: what it is, why it is owed, what the
+   * Ack does AND does not do. The control stays pending on any HTTP
+   * ambiguity — only the authoritative snapshot closes the row. */
+  private ownerAckRow(row: OwnerAckRow, bandVisible: boolean): HTMLElement {
+    const item = row.notification;
+    // The interactive control carries the action id (focus/addressing
+    // target); the wrapper stays anonymous so a query always lands on
+    // the control, never a lookalike parent.
+    const node = el('article', `board-owner__row board-owner__row--${item.severity}`);
+    node.append(
+      el('div', 'board-owner__title', `🔔 ${item.title}`),
+      el(
+        'div',
+        'board-owner__meta lbl',
+        `${formatTs(item.ts)} · owner ack owed${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`,
+      ),
+      el('div', 'lbl board-owner__consequence', row.consequence),
+    );
+    const ack = document.createElement('button');
+    ack.type = 'button';
+    ack.className = 'board-owner__ack';
+    ack.textContent = 'Ack';
+    ack.dataset.actionId = row.actionId;
+    ack.addEventListener('click', () => {
+      ack.disabled = true;
+      ack.textContent = 'acking…';
+      void this.boardClient
+        ?.ackNotification(item.id)
+        .then(() => {
+          /* Success is NOT completion — the row closes only when the
+           * authoritative snapshot carries ackedAt (any device). */
+        })
+        .catch(() => {
+          // Ambiguous/failed HTTP: the obligation stands. Restore the
+          // control; the next snapshot reconciles one authoritative truth.
+          ack.disabled = false;
+          ack.textContent = 'Ack';
+        });
+    });
+    node.append(ack);
+    // Display receipt for what the band actually displayed (shown:true
+    // doctrine) — a receipt is proof of display, never of completion.
+    if (bandVisible) this.sendShown(item, 'web-board');
+    return node;
+  }
+
+  /** One evidence-bound ready PR: affected heist, the exact head every
+   * piece of evidence is bound to, and OPEN PR — an external link, not
+   * an in-app merge. Nothing here claims the merge happened. */
+  private ownerPrRow(row: OwnerPrRow): HTMLElement {
+    const pr = row.pr;
+    const node = el('article', 'board-owner__row board-owner__row--pr');
+    node.append(
+      el('div', 'board-owner__title', `🔀 ${pr.jobTitle}`),
+      el(
+        'span',
+        'pp-chip pp-chip--done board-owner__ready',
+        'ready for you',
+      ),
+      el(
+        'div',
+        'board-owner__meta lbl',
+        `📦 ${pr.repo} · review approved @ ${pr.sha.slice(0, 8)} · CI green at that head · mergeable`,
+      ),
+    );
+    const href = safePrUrl(pr.prUrl);
+    if (href !== null) {
+      const open = el('a', 'board-owner__open', 'OPEN PR ↗');
+      open.href = href;
+      open.target = '_blank';
+      open.rel = 'noreferrer';
+      open.dataset.actionId = row.actionId;
+      open.title = 'Opens the PR on GitHub — merging stays your call there';
+      node.append(open);
+    } else {
+      // Fail closed: an unsafe URL never becomes a link (the server
+      // already refuses to project these; this is the browser guard).
+      node.append(el('span', 'lbl board-owner__nolink', 'PR link unavailable'));
+    }
+    return node;
+  }
+
   // ------------------------------------------------------------------
   // Status chip rail (v6: the v4 health row, relocated + counts folded)
   // ------------------------------------------------------------------

===== END DIFF =====
