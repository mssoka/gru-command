/**
 * ──────────────────────────── DEV TOOLING ONLY ────────────────────────────
 * Mock Gru chat socket for frontend development (E5). Implements the WS
 * protocol contract (web/src/lib/protocol.ts) exactly as the real E4 socket
 * will: token auth on the first frame, seq'd frames, replay-on-reconnect
 * from its in-memory log, and a scripted deterministic reply.
 *
 * This file is NEVER part of the production service or bundle. Run it with:
 *   npm run mock            (GRU_MOCK_PORT=8787, GRU_MOCK_TOKEN=dev-token)
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { assertSafeTestServicePort } from '../../test/helpers/real-service.mjs';
import { DEFAULT_MOCK_TOKEN, resolveMockExposure } from './safety.js';
import {
  parseClientFrame,
  type AttachmentChip,
  type ContextControlState,
  type ControlFrame,
  type ErrorFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from '../src/lib/protocol.js';

const PORT = Number(process.env.GRU_MOCK_PORT ?? 8787);
// Dev/test tooling never squats the instance port (owner incident 2026-09-23).
assertSafeTestServicePort(PORT, 'mock server');
const EXPOSURE = resolveMockExposure(process.env);
const HOST = EXPOSURE.host;
const TOKEN = EXPOSURE.token;
const AUTH_DEADLINE_MS = 5_000;
const DELTA_INTERVAL_MS = 45;

/** In-memory frame log — the mock's stand-in for the session store. */
const log: LoggedFrame[] = [];
let seq = 0;
let epoch = 0;
let replayFloorSeq = 0;
let controlState: ContextControlState = 'idle';
let failNextCompact = false;
let failNextNewChat = false;
/** One-shot turn hold (tests only): the next scripted reply parks at the end
 * of its token stream and stays `busy` until POST /__turn-release (or the
 * socket closes), so the working-flavor rotation is observable in a real
 * browser without racing a short stream. Cleared by /__reset. */
let holdNextTurn = false;
let releaseHeldTurn: (() => void) | null = null;
let compactGeneration = 0;
let newChatGeneration = 0;
/** Reflow stress controls (owner heist 2026-09-29, tests only): the next
 * scripted reply runs under this tool name and/or emits this error line.
 * Long unbroken tokens prove the chat pane never scrolls horizontally;
 * consumed once, cleared by /__reset. */
let stressTool: string | null = null;
let stressError: string | null = null;
const deferredUsers: Array<{ socket: WebSocket; frame: UserFrame }> = [];
const chatClients = new Map<WebSocket, { writer: boolean }>();

function nextSeq(): number {
  seq += 1;
  return seq;
}

function record(frame: LoggedFrame): LoggedFrame {
  log.push(frame);
  return frame;
}

function send(socket: WebSocket, frame: ServerFrame): void {
  socket.send(JSON.stringify(frame));
}

function sendContext(socket: WebSocket): void {
  send(socket, {
    type: 'context',
    epoch,
    replay_floor_seq: replayFloorSeq,
    state: controlState,
    usage: null,
    compact_supported: true,
    session_active: true,
    writer: chatClients.get(socket)?.writer === true,
  });
}

function broadcastContext(): void {
  for (const socket of chatClients.keys()) {
    if (socket.readyState === WebSocket.OPEN) sendContext(socket);
  }
}

function broadcastFrame(frame: LoggedFrame, except?: WebSocket): void {
  for (const socket of chatClients.keys()) {
    if (socket !== except && socket.readyState === WebSocket.OPEN) send(socket, frame);
  }
}

function sendError(socket: WebSocket, message: string, fatal: boolean): void {
  // Every seq-consuming frame is logged: the counter must always equal the
  // log's high-water mark, or replay-end arithmetic wedges for clients.
  let frame: ErrorFrame;
  if (fatal) {
    frame = { type: 'error', message, fatal: true };
  } else {
    frame = { type: 'error', message, seq: nextSeq() };
    record(frame);
  }
  send(socket, frame);
}

/** Deterministic scripted Gru reply: turn → tool activity → deltas → end. */
function scriptedReply(socket: WebSocket, userText: string, attachments?: readonly AttachmentChip[]): void {
  controlState = 'busy';
  broadcastContext();
  // Attach chips echo as PATH lines (SPEC ruling 19 parity: the mock is
  // the executable spec — paths, never pasted bytes).
  const chipLines = (attachments ?? []).map((chip) => `📎 ${chip.name} → ${chip.path}`).join(' ');
  const reply =
    `Mock Gru here, boss! You said: "${userText}". ` +
    (chipLines === '' ? '' : `${chipLines}. `) +
    'The real brain plugs in when E4 lands — until then I echo with pride. 🪐';
  const toolName = stressTool ?? 'mock-echo';
  stressTool = null;
  const toolError = stressError;
  stressError = null;
  const tokens = reply.split(/(?<=\s)/); // word-sized chunks, spaces kept

  emit({ type: 'turn', state: 'start', seq: nextSeq() });
  emit({ type: 'tool', name: toolName, state: 'start', seq: nextSeq() });

  let index = 0;
  let toolEnded = false;
  let settled = false;
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      finish();
      return;
    }
    if (index === 2 && !toolEnded) {
      toolEnded = true;
      emit({ type: 'tool', name: toolName, state: 'end', seq: nextSeq() });
      if (toolError !== null) emit({ type: 'error', message: toolError, seq: nextSeq() });
    }
    const chunk = tokens[index];
    if (chunk === undefined) {
      if (holdNextTurn) {
        holdNextTurn = false;
        // Stop polling exhausted tokens while held: otherwise the next
        // interval tick falls through to finish() without a release.
        clearInterval(timer);
        releaseHeldTurn = finish;
        return;
      }
      finish();
      return;
    }
    emit({ type: 'delta', text: chunk, seq: nextSeq() });
    index += 1;
  }, DELTA_INTERVAL_MS);

  socket.once('close', finish);

  // One exit for every ending — normal, released, or dropped socket: the
  // closing frames are recorded (and broadcast to survivors) so replays
  // always see a settled turn.
  function finish(): void {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    releaseHeldTurn = null;
    socket.off('close', finish);
    if (!toolEnded) {
      toolEnded = true;
      emit({ type: 'tool', name: toolName, state: 'end', seq: nextSeq() });
    }
    emit({ type: 'turn', state: 'end', seq: nextSeq() });
    controlState = 'idle';
    broadcastContext();
    drainDeferredUsers();
  }

  function emit(frame: LoggedFrame): void {
    record(frame);
    broadcastFrame(frame);
  }
}

/**
 * ── Board feed (E6, dev-only) ──────────────────────────────────────────
 * A GENERIC sample snapshot (no real project names, ever — hygiene
 * ruling): two repos, a live round with per-lens chips in mixed states,
 * the standing crew on the agent rail, one blocked-job notification.
 * The board WS pushes a fresh copy after auth and on every /__pulse.
 */
const LENSES = ['blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests', 'performance', 'operations'] as const;

/** Board fixture mode (tests only): the default sample board, or a variant
 * with no live machine rows and no needs-you job causes so the empty
 * NEEDS GRU clear state is assertable in both themes. /__reset restores. */
type BoardMode = 'default' | 'clear-needs-you';
let boardMode: BoardMode = 'default';

/** A stamp 20 minutes ago, clamped to stay inside the current LOCAL day:
 * the merged-receipt fixture must keep bucketing SETTLED even when the
 * mock boots just after midnight (the rolling-window pins depend on it). */
function mergedReceiptStamp(): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  // Never in the future: just after local midnight the 20-minute lookback
  // crosses yesterday, so the clamp to today+60s would run ahead of
  // Date.now() and skew recency ordering. Cap at now.
  return new Date(
    Math.min(Date.now(), Math.max(Date.now() - 20 * 60_000, startOfToday.getTime() + 60_000)),
  ).toISOString();
}

function sampleSnapshot(): unknown {
  const snapshot = defaultSampleSnapshot();
  return boardMode === 'clear-needs-you' ? clearNeedsYouVariant(snapshot) : snapshot;
}

/** The clear variant: drop the live machine row, settle the needs-you
 * causes of the two remaining fixture jobs (a failed lens and a conflicting
 * PR), and zero the queue count — the board then renders the calm green
 * "nothing needs Gru" state. Everything else is unchanged. */
function clearNeedsYouVariant(snapshot: unknown): unknown {
  const snap = snapshot as {
    repos: Array<{ jobs: Array<Record<string, unknown>> }>;
    notifications: Array<Record<string, unknown>>;
    unackedActionRequired: number;
  };
  snap.notifications = snap.notifications.filter((row) => row.id !== 'mock-n5');
  snap.unackedActionRequired = 0;
  for (const repo of snap.repos) {
    for (const job of repo.jobs) {
      if (job.id === 'demo-api-payment-fix' && Array.isArray(job.rounds)) {
        for (const round of job.rounds as Array<{ lenses?: Array<Record<string, unknown>> }>) {
          for (const lens of round.lenses ?? []) {
            if (lens.state === 'error') {
              lens.state = 'done';
              lens.note = null;
            }
          }
        }
      }
      if (job.id === 'demo-api-conflict-probe') job.prState = 'open';
    }
  }
  return snap;
}

function defaultSampleSnapshot(): unknown {
  return {
    repos: [
      {
        name: 'demo-api',
        jobs: [
          {
            id: 'demo-api-payment-fix',
            repo: 'demo-api',
            title: 'Fix the payment retry loop',
            status: 'in-review',
            updatedAt: new Date().toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: 'awaiting review round 2',
            rounds: [
              {
                id: 'demo-api-payment-fix-r2',
                seq: 2,
                status: 'live',
                verdict: null,
                targetRef: 'abc1234',
                createdAt: new Date(Date.now() - 900_000).toISOString(),
                updatedAt: new Date().toISOString(),
                lensAttempts: [
                  { lens: 'blind', attempts: 2 },
                  { lens: 'edge', attempts: 1 },
                  { lens: 'acceptance', attempts: 1 },
                ],
                blockers: 1,
                lenses: LENSES.map((lens, index) => ({
                  lens,
                  state: index < 3 ? 'done' : index === 3 ? 'live' : index === 4 ? 'error' : 'pending',
                  agentId: `mock-lens-${lens}`,
                  note:
                    index === 2
                      ? 'blocker — retry path can double-charge'
                      : index === 4
                        ? 'provider cap hit'
                        : null,
                  verdict: index === 2 ? 'blocker' : null,
                })),
              },
            ],
            lane: {
              branch: 'gru/demo-api-payment-fix',
              sha: 'abc1234def5678',
              status: 'active',
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
            },
            lastAgentActivity: new Date(Date.now() - 45_000).toISOString(),
          },
          {
            id: 'demo-api-docs-pass',
            repo: 'demo-api',
            title: 'Docs pass on the public endpoints',
            status: 'parked',
            updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: null,
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          },
          {
            // Section truth: a merged lane with a leftover unacked
            // escalation row is a closed receipt — SETTLED, never NEEDS
            // YOU, and the unacked chip does not count it.
            id: 'demo-api-merged-leftover',
            repo: 'demo-api',
            title: 'Rotate the staging tokens',
            status: 'merged',
            updatedAt: mergedReceiptStamp(),
            prUrl: 'https://example.invalid/pr/41',
            prState: 'merged',
            baseBranch: 'main',
            note: 'merged — the leftover escalation row is a closed receipt, not live work',
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          },
          {
            // Stopped-worker truth: the supervisor walled this lane on a
            // provider quota — it waits with its reason, it is not "working".
            id: 'demo-api-quota-walled',
            repo: 'demo-api',
            title: 'Migrate the search index',
            status: 'working',
            updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: 'worker stopped by supervision — waiting on provider',
            rounds: [],
            lane: {
              branch: 'gru/demo-api-quota-walled',
              sha: 'ccc3333ddd4444',
              status: 'active',
              createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
            },
            // Backdated past the 30-minute stall window so the e2e's 'not
            // COLD' assertion actually exercises the stop exemption: the
            // lane is IN FLIGHT only because its stopped worker is waiting
            // on a re-arm, not because its stamp is fresh (review B4).
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          },
          {
            id: 'demo-api-conflict-probe',
            repo: 'demo-api',
            title: 'Merge main into the retry branch',
            status: 'in-review',
            updatedAt: new Date(Date.now() - 300_000).toISOString(),
            prUrl: 'https://example.invalid/pr/43',
            prState: 'conflicting',
            baseBranch: 'main',
            note: 'PR conflicts with main — rebase owed',
            rounds: [],
            lane: null,
            lastAgentActivity: new Date(Date.now() - 300_000).toISOString(),
          },
          {
            id: 'demo-api-stalled-lane',
            repo: 'demo-api',
            title: 'Backfill the audit log',
            status: 'working',
            updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: 'no frames for 45m — the demoter sinks this to COLD',
            rounds: [],
            lane: {
              branch: 'gru/demo-api-stalled-lane',
              sha: 'aaa1111bbb2222',
              status: 'active',
              createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
            },
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          },
        ],
      },
      {
        name: 'sample-site',
        jobs: [
          {
            id: 'sample-site-copy-pass',
            repo: 'sample-site',
            title: 'Landing copy refresh',
            status: 'working',
            updatedAt: new Date(Date.now() - 600_000).toISOString(),
            prUrl: 'https://example.invalid/pr/42',
            prState: 'open',
            baseBranch: 'main',
            note: null,
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          },
          {
            id: 'sample-site-hero-settle',
            repo: 'sample-site',
            title: 'Ship the hero section',
            status: 'delivered',
            updatedAt: new Date(Date.now() - 1_800_000).toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: 'delivered — awaiting the review gate',
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          },
          // v5 rolling window: 13 settled jobs total (hero + 11 older + the
          // merged demo-api receipt), so the mock renders 10 cards + a
          // "+3 older settled" footer (the e2e pins both).
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `sample-site-settled-${index + 1}`,
            repo: 'sample-site',
            title: `Settled batch ${index + 1}`,
            status: 'delivered',
            updatedAt: new Date(Date.now() - (index + 2) * 3_600_000).toISOString(),
            prUrl: null,
            prState: null,
            baseBranch: 'main',
            note: null,
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          })),
        ],
      },
    ],
    agents: [
      // #171 truthful agent status fixtures: every row carries its runtime
      // classification. The gru row shows the misleading-idle correction
      // (raw idle, open supervision turn → derived `streaming`); the two
      // September rows are verified-historical sessions behind the
      // history disclosure; the rest are the current crew.
      { id: 'mock-gru', role: 'gru', label: 'gru · chat', state: 'idle', status: 'streaming', runtime: 'current', lastActivity: new Date(Date.now() - 3_600_000).toISOString(), createdAt: new Date(Date.now() - 3_600_000).toISOString(), sessionFile: 'gru/--demo--aa111111/mock-session.jsonl', jobId: null, roundId: null, supervision: { state: 'watching', restarts: 0, breakerOpen: false, openTurn: true, openToolCalls: 1, lastEventAt: new Date(Date.now() - 25_000).toISOString() } },
      { id: 'mock-silas', role: 'silas', label: 'silas · ops', state: 'streaming', status: 'streaming', runtime: 'current', lastActivity: new Date(Date.now() - 12_000).toISOString(), createdAt: new Date(Date.now() - 900_000).toISOString(), sessionFile: null, jobId: null, roundId: null, supervision: { state: 'watching', restarts: 1, breakerOpen: false } },
      { id: 'mock-silas-sept', role: 'silas', label: 'silas · ops (Sept 29)', state: 'streaming', status: 'streaming', runtime: 'historical', lastActivity: '2026-09-29T18:04:00.000Z', createdAt: '2026-09-29T17:00:00.000Z', sessionFile: null, jobId: null, roundId: null, supervision: null },
      { id: 'mock-lens-blind', role: 'perkins', label: 'blind:001', state: 'idle', status: 'idle', runtime: 'current', lastActivity: new Date(Date.now() - 300_000).toISOString(), createdAt: new Date(Date.now() - 600_000).toISOString(), sessionFile: null, jobId: null, roundId: 'demo-api-payment-fix-r2', supervision: null },
      { id: 'mock-minion', role: 'minion', label: 'demo-api-payment-fix', state: 'idle', status: 'idle', runtime: 'current', lastActivity: null, createdAt: new Date(Date.now() - 3_600_000).toISOString(), sessionFile: null, jobId: 'demo-api-payment-fix', roundId: null, supervision: { state: 'stopped', restarts: 3, breakerOpen: true, stopReason: 'crash loop' } },
      { id: 'mock-minion-quota', role: 'minion', label: 'demo-api-quota-walled', state: 'idle', status: 'idle', runtime: 'current', lastActivity: new Date(Date.now() - 45 * 60_000).toISOString(), createdAt: new Date(Date.now() - 1_800_000).toISOString(), sessionFile: null, jobId: 'demo-api-quota-walled', roundId: null, supervision: { state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' } },
      { id: 'mock-minion-merged', role: 'minion', label: 'demo-api-merged-leftover', state: 'idle', status: 'idle', runtime: 'current', lastActivity: null, createdAt: new Date(Date.now() - 1_800_000).toISOString(), sessionFile: null, jobId: 'demo-api-merged-leftover', roundId: null, supervision: { state: 'watching', restarts: 0, breakerOpen: false, stopReason: null } },
      // #171 owner-held stop: the breaker released the handle (ledger state
      // disposed) while the current supervisor still owns the lane — the
      // rail keeps it in the live crew with its stopped mark, never in the
      // graveyard.
      { id: 'mock-minion-held', role: 'minion', label: 'held-after-breaker', state: 'disposed', status: 'disposed', runtime: 'current', lastActivity: new Date(Date.now() - 600_000).toISOString(), createdAt: new Date(Date.now() - 2_400_000).toISOString(), sessionFile: null, jobId: null, roundId: null, supervision: { state: 'stopped', restarts: 3, breakerOpen: true, stopReason: 'crash loop' } },
      { id: 'mock-minion-sept', role: 'minion', label: 'sample-site-copy-pass (Sept 29)', state: 'streaming', status: 'streaming', runtime: 'historical', lastActivity: '2026-09-29T21:12:00.000Z', createdAt: '2026-09-29T20:00:00.000Z', sessionFile: null, jobId: 'sample-site-copy-pass', roundId: null, supervision: null },
      { id: 'mock-bob', role: 'bob', label: 'bob · memory', state: 'idle', status: 'idle', runtime: 'current', lastActivity: null, createdAt: new Date(Date.now() - 5_400_000).toISOString(), sessionFile: null, jobId: null, roundId: null, supervision: null },
      { id: 'mock-gru-old', role: 'gru', label: 'gru · chat (retired)', state: 'disposed', status: 'disposed', runtime: 'historical', lastActivity: new Date(Date.now() - 7_200_000).toISOString(), createdAt: new Date(Date.now() - 10_800_000).toISOString(), sessionFile: null, jobId: null, roundId: null, supervision: null },
    ],
    notifications: [
      { id: 'mock-n1', ts: new Date().toISOString(), kind: 'job.status', routing: 'fyi', severity: 'error', title: 'Job demo-api-payment-fix blocked', detail: 'waiting on the base sync', agentId: null, shownAt: null, ackedAt: null, resolvedAt: null, resolvedBy: null },
      { id: 'mock-n2', ts: new Date(Date.now() - 120_000).toISOString(), kind: 'round.verdict', routing: 'fyi', severity: 'info', title: 'Round r1 verdict', detail: 'approved', agentId: null, shownAt: new Date().toISOString(), ackedAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null },
      // Needs-owner stops (ack re-arms supervision) ring the FOR YOU band / bell.
      { id: 'mock-n3', ts: new Date(Date.now() - 240_000).toISOString(), kind: 'supervision.breaker', routing: 'needs-owner', severity: 'error', title: 'Crash-loop breaker tripped: agent mock-minion stopped', detail: '3 restarts within 600s. The agent is STOPPED — ack this notification to re-arm supervision and resume.', agentId: 'mock-minion', shownAt: new Date().toISOString(), ackedAt: null, resolvedAt: null, resolvedBy: null },
      // Provider-wall stops are owner-held too: resolve the provider, then ack to re-arm.
      { id: 'mock-n4', ts: new Date(Date.now() - 900_000).toISOString(), kind: 'supervision.provider-wall.demo-api-quota-walled.quota_wall', routing: 'needs-owner', severity: 'error', title: 'Agent mock-minion-quota stopped: quota wall', detail: 'Blind restart is withheld. Resolve the provider condition, then ack to re-arm the deterministic restart ladder.', agentId: 'mock-minion-quota', shownAt: new Date().toISOString(), ackedAt: null, resolvedAt: null, resolvedBy: null },
      // Machine attention lives in the self-clearing NEEDS GRU queue — a live global row keeps the tracker legible.
      { id: 'mock-n5', ts: new Date(Date.now() - 300_000).toISOString(), kind: 'review-escalation', routing: 'action-required', severity: 'error', title: 'Review round demo-api-payment-fix-r1 is INCOMPLETE', detail: 'lead session aborted — the lane can be re-armed', agentId: null, shownAt: null, ackedAt: null, resolvedAt: null, resolvedBy: null },
      // Section truth: a leftover MACHINE row bound to the merged lane is a
      // closed receipt — the record keeps it, the live count does not.
      { id: 'mock-n6', ts: new Date(Date.now() - 2_400_000).toISOString(), kind: 'review-escalation', routing: 'action-required', severity: 'error', title: 'Leftover machine escalation on the merged lane', detail: 'The lane merged anyway. Closed receipt: kept for the record, never live queue.', agentId: 'mock-minion-merged', shownAt: new Date().toISOString(), ackedAt: null, resolvedAt: null, resolvedBy: null },
    ],
    decisions: {
      enabled: true,
      status: 'ready',
      reason: null,
      model: 'typesafe/jev-1.13-20260917',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: true,
      credentialSource: 'file',
      checkedAt: new Date().toISOString(),
      incarnation: 'mock-incarnation',
      generation: 1,
    },
    // LIVE machine rows only: the global review escalation (n5) counts;
    // the merged lane's leftover n6 is a closed receipt — the record keeps
    // it, this count (and NEEDS GRU) does not.
    unackedActionRequired: 1,
    // Owner stops ring the bell (FOR YOU): the crash-loop stop and the
    // provider-wall stop await the owner's ack.
    unackedNeedsOwner: 2,
    // FOR YOU (owner approval 2026-09-28): one evidence-bound ready PR.
    // Generic sample data only — the readiness story is exact-head
    // (approved round + clean + green CI at the same sha); the row's
    // action is OPEN PR (external), never an in-app merge.
    ownerPrs: [
      {
        id: 'owner-pr:demo-api-payment-fix',
        jobId: 'demo-api-payment-fix',
        jobTitle: 'Fix the payment retry loop',
        repo: 'demo-api',
        prUrl: 'https://example.invalid/pr/41',
        sha: '5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a',
        checkedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
    wakes: { count: 2, lastAt: new Date(Date.now() - 180_000).toISOString() },
    build: {
      buildRev: 'abc1234def5678abc1234def5678abc1234def56',
      buildCommittedAt: new Date(Date.now() - 5_400_000).toISOString(),
      originMainRev: 'def5678abc1234def5678abc1234def5678abc12',
      originMainCommittedAt: new Date(Date.now() - 600_000).toISOString(),
      commitsBehind: 3,
      checkedAt: new Date().toISOString(),
      checkError: null,
    },
    silas: {
      lastWakeAt: new Date(Date.now() - 240_000).toISOString(),
      lastTickAt: new Date(Date.now() - 60_000).toISOString(),
      lastReconcileAt: new Date(Date.now() - 60_000).toISOString(),
      lastReconcileFailedAt: null,
      reconcileFailedNewer: false,
      lastUsefulActionAt: new Date(Date.now() - 120_000).toISOString(),
      nextAction: 'gru-decision: rule on the completed audit (demo-job)',
      openTurnSince: new Date(Date.now() - 240_000).toISOString(),
      reconciliationsToday: 2,
      checkedAt: new Date().toISOString(),
    },
    verify: {
      lockInUse: false,
      activeRuns: 0,
      queuedRuns: 1,
      workerBudget: 8,
      workersPerRun: 4,
    },
    selfHeal: null,
  };
}

const SAMPLE_TRANSCRIPT_FILE = 'gru/--demo--aa111111/mock-session.jsonl';
const SAMPLE_TRANSCRIPT = [
  { type: 'user', text: 'mock transcript: plan the launch' },
  { type: 'assistant', text: 'on it, boss — three steps, one review round' },
  { type: 'user', text: 'what about the secret sauce metric?' },
  { type: 'assistant', text: 'tracked on the board as a round chip' },
];

/** Mock attach surface (review r1: the one flow must work in dev/mock
 * mode too). Browse serves a small generic sample tree; uploads
 * materialize into a throwaway dir so chips carry a REAL path shape. */
const MOCK_UPLOADS_DIR = mkdtempSync(join(tmpdir(), 'gru-mock-uploads-'));
const MOCK_BROWSE_ROOT = '/workspace';

/** Keep dev defaults fixed and bounded. NODE_ENV=test may only LOWER the
 * limits so endpoint tests exercise every boundary without multi-megabyte
 * fixtures or a thousand writes. */
function mockTestLimit(name: string, productionLimit: number): number {
  if (process.env.NODE_ENV !== 'test') return productionLimit;
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return productionLimit;
  return Math.min(parsed, productionLimit);
}

const MOCK_MAX_UPLOAD_BYTES = mockTestLimit('GRU_MOCK_TEST_MAX_UPLOAD_BYTES', 8 * 1024 * 1024);
const MOCK_MAX_UPLOAD_BODY_BYTES = Math.ceil((MOCK_MAX_UPLOAD_BYTES * 4) / 3) + 4096;
const MOCK_MAX_UPLOAD_FILES = mockTestLimit('GRU_MOCK_TEST_MAX_UPLOAD_FILES', 1_000);
let mockUploadCount = 0;

function mockUploadName(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? '';
  const cleaned = basename.replace(/[^\p{L}\p{N}._ +-]/gu, '_').replace(/^\.+/, '') || 'upload';
  let bounded = '';
  let bytes = 0;
  for (const char of cleaned) {
    const width = Buffer.byteLength(char);
    if (bytes + width > 200) break;
    bounded += char;
    bytes += width;
  }
  return bounded || 'upload';
}

function mockBrowse(path: string): unknown {
  const tree: Record<string, Array<{ name: string; kind: 'dir' | 'file'; size: number | null; image: boolean; pickable: boolean }>> = {
    '': [
      { name: 'sample-repo', kind: 'dir', size: null, image: false, pickable: true },
      { name: 'mock-notes.md', kind: 'file', size: 128, image: false, pickable: true },
      { name: 'mock-shot.png', kind: 'file', size: 2048, image: true, pickable: true },
    ],
    'sample-repo': [{ name: 'README.md', kind: 'file', size: 64, image: false, pickable: true }],
  };
  const entries = tree[path] ?? [];
  const parent = path === '' ? null : (path.split('/').slice(0, -1).join('/') || '');
  return { root: MOCK_BROWSE_ROOT, path, parent, truncated: false, entries };
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Board API (dev-only, generic sample data; token matches the chat token).
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/board') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sampleSnapshot()) + '\n');
    return;
  }
  if (
    (req.method === 'GET' && url.pathname === '/api/decisions/status') ||
    (req.method === 'POST' && url.pathname === '/api/decisions/recheck')
  ) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    const snapshot = sampleSnapshot() as { decisions: unknown };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshot.decisions) + '\n');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/transcripts') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        transcripts: [
          { file: SAMPLE_TRANSCRIPT_FILE, role: 'gru', sizeBytes: 1024, modifiedAt: new Date().toISOString(), agentId: 'mock-gru', agentLabel: 'gru · chat' },
        ],
      }) + '\n',
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/transcripts/file') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    const file = url.searchParams.get('file') ?? '';
    const q = url.searchParams.get('q');
    if (file !== SAMPLE_TRANSCRIPT_FILE) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (q !== null && q !== '') {
      const needle = q.toLowerCase();
      const matches = SAMPLE_TRANSCRIPT.map((entry, index) => ({ index, kind: entry.type, text: entry.text }))
        .filter((entry) => entry.text.toLowerCase().includes(needle))
        .map((entry) => ({ index: entry.index, kind: entry.kind, snippet: `…${entry.text.slice(0, 60)}…` }));
      res.end(
        JSON.stringify({ file, query: q, matches, scanned: SAMPLE_TRANSCRIPT.length, total: SAMPLE_TRANSCRIPT.length }) + '\n',
      );
      return;
    }
    const before = url.searchParams.get('before');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 2 : Math.max(1, Math.min(Number(limitRaw) || 2, 200));
    const upper = before === null ? SAMPLE_TRANSCRIPT.length : Math.min(Number(before), SAMPLE_TRANSCRIPT.length);
    const lower = Math.max(0, upper - limit);
    res.end(
      JSON.stringify({
        file,
        total: SAMPLE_TRANSCRIPT.length,
        entries: SAMPLE_TRANSCRIPT.slice(lower, upper)
          .map((entry, offset) => ({ index: lower + offset, ts: null, kind: entry.type, role: entry.type, text: entry.text, thinking: null, toolName: null, isError: false }))
          .reverse(),
        nextCursor: lower > 0 ? lower : null,
        skippedTornLines: 0,
      }) + '\n',
    );
    return;
  }
  // POST /__pulse nudges board clients with a fresh sample snapshot.
  if (req.method === 'GET' && url.pathname === '/api/attach/browse') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mockBrowse(url.searchParams.get('path') ?? '')) + '\n');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/attach/uploads') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > MOCK_MAX_UPLOAD_BODY_BYTES) {
        if (!rejected) {
          rejected = true;
          body = '';
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end('{"error":"attach_failed","detail":"request body exceeds mock upload limit"}\n');
        }
        return;
      }
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(body) as { filename?: string; content_base64?: string };
        const filename = mockUploadName(
          typeof parsed.filename === 'string' && parsed.filename !== '' ? parsed.filename : 'upload',
        );
        const bytes = Buffer.from(parsed.content_base64 ?? '', 'base64');
        if (bytes.byteLength === 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"attach_failed","detail":"content_base64 must be a non-empty string"}\n');
          return;
        }
        if (bytes.byteLength > MOCK_MAX_UPLOAD_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'attach_failed',
              detail: `upload exceeds ${MOCK_MAX_UPLOAD_BYTES} byte mock limit`,
            }) + '\n',
          );
          return;
        }
        if (mockUploadCount >= MOCK_MAX_UPLOAD_FILES) {
          res.writeHead(507, { 'content-type': 'application/json' });
          res.end('{"error":"attach_failed","detail":"mock upload quota exceeded"}\n');
          return;
        }
        const target = join(
          MOCK_UPLOADS_DIR,
          `${Date.now()}-${mockUploadCount}-${filename}`,
        );
        writeFileSync(target, bytes, { flag: 'wx' });
        mockUploadCount += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: target, name: filename, bytes: bytes.byteLength }) + '\n');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"attach_failed","detail":"bad upload body"}\n');
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/__pulse') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    for (const client of boardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'board', snapshot: sampleSnapshot() }));
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  // Dev control plane (tests): POST /__reset clears the frame log;
  // POST /__drop terminates every connected socket; POST /__stress fits
  // the next scripted reply with a long tool name / error line (reflow
  // evidence); POST /__turn-hold parks the next settled reply in `busy`
  // until POST /__turn-release (working-flavor evidence); the failure
  // endpoints fail the next matching context control after its visible
  // progress state.
  if (req.method === 'POST' && req.url === '/__compact-fail') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    failNextCompact = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__new-chat-fail') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    failNextNewChat = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__turn-hold') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    holdNextTurn = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__turn-release') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    const release = releaseHeldTurn;
    releaseHeldTurn = null;
    if (release !== null) release();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__drop') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    for (const socket of server.clients) socket.terminate();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__board-mode') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { mode?: string };
        if (parsed.mode !== 'default' && parsed.mode !== 'clear-needs-you') throw new Error('bad mode');
        boardMode = parsed.mode;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}\n');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"mode must be default|clear-needs-you"}\n');
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/__stress') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { tool?: string; error?: string };
        stressTool = typeof parsed.tool === 'string' && parsed.tool !== '' ? parsed.tool : null;
        stressError =
          typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}\n');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bad stress body"}\n');
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}\n');
      return;
    }
    // Counters may rewind only after every client is detached; otherwise a
    // live browser observes impossible seq/epoch regression.
    for (const socket of server.clients) socket.terminate();
    chatClients.clear();
    log.length = 0;
    seq = 0;
    epoch = 0;
    replayFloorSeq = 0;
    controlState = 'idle';
    failNextCompact = false;
    failNextNewChat = false;
    holdNextTurn = false;
    releaseHeldTurn = null;
    stressTool = null;
    stressError = null;
    boardMode = 'default';
    compactGeneration += 1;
    newChatGeneration += 1;
    deferredUsers.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"mock: ws endpoint is /ws; POST /__reset clears the log"}\n');
});

// Two noServer wss instances behind ONE manual upgrade router — two
// `{server, path}` instances would reject each other's upgrades (the
// first-attached wss answers 400 for every foreign path).
const server = new WebSocketServer({ noServer: true });
const boardClients = new Set<WebSocket>();
const boardServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.host !== request.headers.host
      ) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }
  if (pathname === '/ws') {
    server.handleUpgrade(request, socket, head, (ws) => server.emit('connection', ws, request));
    return;
  }
  if (pathname === '/board/ws') {
    boardServer.handleUpgrade(request, socket, head, (ws) => boardServer.emit('connection', ws, request));
    return;
  }
  socket.destroy();
});

// Application-level keepalive parity with the service: the board client
// refreshes its liveness clock on ANY frame, so a quiet dev board must see
// pings or it would (correctly) declare its socket stale every window.
const mockBoardHeartbeat = setInterval(() => {
  for (const socket of boardClients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
  }
}, 20_000);
mockBoardHeartbeat.unref();

boardServer.on('connection', (socket) => {
  let authed = false;
  const deadline = setTimeout(() => {
    if (!authed) {
      socket.send(JSON.stringify({ type: 'error', message: 'auth timeout', fatal: true }));
      socket.close();
    }
  }, AUTH_DEADLINE_MS);
  socket.on('message', (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsed = null;
    }
    const token =
      typeof parsed === 'object' && parsed !== null && (parsed as { token?: unknown }).token;
    if (authed || typeof token !== 'string' || token !== TOKEN) {
      if (!authed) {
        clearTimeout(deadline);
        socket.send(JSON.stringify({ type: 'error', message: 'unauthorized: bad token', fatal: true }));
        socket.close();
      }
      return;
    }
    clearTimeout(deadline);
    authed = true;
    boardClients.add(socket);
    socket.on('close', () => boardClients.delete(socket));
    socket.send(JSON.stringify({ type: 'auth_ok' }));
    socket.send(JSON.stringify({ type: 'board', snapshot: sampleSnapshot() }));
  });
  socket.on('error', () => {
    boardClients.delete(socket);
  });
});

server.on('connection', (socket) => {
  let authed = false;
  const authDeadline = setTimeout(() => {
    if (!authed) {
      sendError(socket, 'auth timeout: first frame must be auth', true);
      socket.close();
    }
  }, AUTH_DEADLINE_MS);

  socket.on('message', (data) => {
    const frame = parseClientFrame(String(data));
    if (frame === null) {
      // Matches the ruled real-server behavior (r1 W1): an UNAUTHENTICATED
      // socket never writes durable history — the pre-auth notice is
      // ephemeral; only authenticated sockets log protocol errors.
      if (authed) {
        sendError(socket, 'malformed frame', false);
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'malformed frame' }));
      }
      return;
    }

    if (!authed) {
      if (frame.type !== 'auth') {
        sendError(socket, 'first frame must be auth', true);
        socket.close();
        return;
      }
      clearTimeout(authDeadline);
      if (frame.token !== TOKEN) {
        sendError(socket, 'unauthorized: bad token', true);
        socket.close();
        return;
      }
      authed = true;
      const writer = ![...chatClients.values()].some((client) => client.writer);
      chatClients.set(socket, { writer });
      const lastSeen = frame.last_seen_seq ?? 0;
      // auth_ok.seq is the log high-water mark; because every seq-consuming
      // frame is logged, counter === max logged seq at all times.
      send(socket, { type: 'auth_ok', seq });
      sendContext(socket);
      for (const logged of log) {
        const frameSeq = 'seq' in logged && typeof logged.seq === 'number' ? logged.seq : 0;
        if (frameSeq > Math.max(lastSeen, replayFloorSeq)) send(socket, logged);
      }
      return;
    }

    if (frame.type === 'auth') {
      sendError(socket, 'already authenticated', false);
      return;
    }
    if (frame.type === 'control') {
      handleControlFrame(socket, frame);
      return;
    }

    handleUserFrame(socket, frame);
  });

  socket.on('close', () => {
    const wasWriter = chatClients.get(socket)?.writer === true;
    chatClients.delete(socket);
    if (wasWriter) {
      const promoted = chatClients.values().next().value as { writer: boolean } | undefined;
      if (promoted !== undefined) promoted.writer = true;
      broadcastContext();
    }
  });
  socket.on('error', () => {
    // A broken client socket must not take the mock down.
  });
});

function handleControlFrame(socket: WebSocket, frame: ControlFrame): void {
  if (chatClients.get(socket)?.writer !== true) {
    send(socket, {
      type: 'control_result',
      action: frame.action,
      request_id: frame.request_id,
      ok: false,
      epoch,
      code: 'read_only',
      message: 'another client holds the pen',
    });
    sendContext(socket);
    return;
  }
  if (controlState !== 'idle') {
    send(socket, {
      type: 'control_result',
      action: frame.action,
      request_id: frame.request_id,
      ok: false,
      epoch,
      code: 'busy',
      message: 'chat is busy',
    });
    sendContext(socket);
    return;
  }
  controlState = frame.action === 'compact' ? 'compacting' : 'resetting';
  broadcastContext();
  if (frame.action === 'compact') {
    // Keep progress visible long enough for browser-level accessibility/UI
    // proof, then emit one deterministic terminal result.
    const generation = ++compactGeneration;
    setTimeout(() => {
      if (generation !== compactGeneration) return;
      const fail = failNextCompact;
      failNextCompact = false;
      controlState = 'idle';
      if (socket.readyState === WebSocket.OPEN) {
        send(socket, fail
          ? {
              type: 'control_result',
              action: frame.action,
              request_id: frame.request_id,
              ok: false,
              epoch,
              code: 'failed',
              message: 'mock native compact failed',
            }
          : {
              type: 'control_result',
              action: frame.action,
              request_id: frame.request_id,
              ok: true,
              epoch,
            });
      }
      broadcastContext();
      drainDeferredUsers();
    }, 300);
    return;
  }
  const generation = ++newChatGeneration;
  const fail = failNextNewChat;
  failNextNewChat = false;
  setTimeout(() => {
    if (generation !== newChatGeneration) return;
    if (fail) {
      if (socket.readyState === WebSocket.OPEN) {
        send(socket, {
          type: 'control_result',
          action: frame.action,
          request_id: frame.request_id,
          ok: false,
          epoch,
          code: 'failed',
          message: 'mock fresh session spawn failed',
        });
      }
      controlState = 'idle';
      broadcastContext();
      drainDeferredUsers();
      return;
    }
    epoch += 1;
    replayFloorSeq = seq;
    // Match production activation ordering: publish the committed boundary
    // while reset is still in progress, then terminal result, then idle.
    broadcastContext();
    if (socket.readyState === WebSocket.OPEN) {
      send(socket, {
        type: 'control_result',
        action: frame.action,
        request_id: frame.request_id,
        ok: true,
        epoch,
      });
    }
    controlState = 'idle';
    broadcastContext();
    drainDeferredUsers();
  }, fail ? 2_500 : 600);
}

function drainDeferredUsers(): void {
  if (controlState !== 'idle') return;
  for (;;) {
    const next = deferredUsers.shift();
    if (next === undefined) return;
    if (next.socket.readyState !== WebSocket.OPEN) continue;
    if (handleUserFrame(next.socket, next.frame)) return;
    // A terminal duplicate starts no reply; keep draining until a unique
    // frame owns the one-at-a-time scripted turn.
  }
}

/** Dedup by epoch + client_msg_id: re-received frames get a fresh ack. */
function handleUserFrame(socket: WebSocket, frame: UserFrame): boolean {
  if (chatClients.get(socket)?.writer !== true) {
    send(socket, { type: 'error', message: 'read-only: another client holds the pen' });
    return false;
  }
  if (controlState !== 'idle') {
    deferredUsers.push({ socket, frame });
    return false;
  }
  if (frame.epoch !== epoch) {
    send(socket, { type: 'error', message: 'stale chat epoch; reconnect required' });
    socket.close(1012, 'stale chat epoch');
    return false;
  }
  const prior = log.find(
    (logged): logged is LoggedFrame & { type: 'user' } =>
      logged.type === 'user' &&
      logged.client_msg_id === frame.client_msg_id &&
      logged.epoch === frame.epoch,
  );
  if (prior !== undefined) {
    send(socket, record({ type: 'ack', client_msg_id: frame.client_msg_id, seq: nextSeq() }));
    return false;
  }
  const loggedUser = record({
    type: 'user',
    text: frame.text,
    client_msg_id: frame.client_msg_id,
    epoch: frame.epoch,
    ...(frame.attachments !== undefined ? { attachments: frame.attachments } : {}),
    seq: nextSeq(),
  });
  broadcastFrame(loggedUser, socket);
  send(socket, record({ type: 'ack', client_msg_id: frame.client_msg_id, seq: nextSeq() }));
  scriptedReply(socket, frame.text, frame.attachments);
  return true;
}

const shutdown = (): void => {
  clearInterval(mockBoardHeartbeat);
  server.close();
  boardServer.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, HOST, () => {
  const urlHost = HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST;
  if (EXPOSURE.warning !== null) process.stderr.write(`${EXPOSURE.warning}\n`);
  process.stdout.write(
    `gru-command MOCK chat socket (dev-only) listening on ws://${urlHost}:${PORT}/ws ` +
      `+ board feed on ws://${urlHost}:${PORT}/board/ws + /api/board ` +
      `(token: ${TOKEN === DEFAULT_MOCK_TOKEN ? 'dev-token [default]' : 'from GRU_MOCK_TOKEN'})\n`,
  );
});
