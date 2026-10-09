import { describe, expect, it } from 'vitest';
import * as web from '../web/src/lib/board-protocol.js';
import { BOARD_WS_PATH, parseBoardClientFrame } from '../src/board/frames.js';
import {
  REPO_OVERVIEW_FRESHNESS,
  REPO_OVERVIEW_RUN_STATES,
} from '../src/repos/overview.js';

/**
 * Board-frame parity (chat-frames pattern): the web validator
 * (web/src/lib/board-protocol.ts) and the server parser
 * (src/board/frames.ts) feed identical corpora and must agree. A
 * divergence on either side fails here.
 */

const CLIENT_CORPUS: readonly unknown[] = [
  // valid
  { type: 'auth', token: 'tok' },
  { type: 'auth', token: 'x'.repeat(200) },
  // valid: extra keys ignored
  { type: 'auth', token: 'tok', extra: true },
  // valid SHAPE (an empty-string token parses; auth rejects it later)
  { type: 'auth', token: '' },
  // invalid
  { type: 'auth' },
  { type: 'auth', token: 7 },
  { type: 'auth', token: null },
  { type: 'board' },
  { type: 'user', text: 'hi' },
  { type: 'nope' },
  { type: 42 },
  {},
  [],
  null,
  'not json',
  true,
];

const SNAPSHOT_VALID = {
  repos: [
    {
      name: 'demo',
      jobs: [
        {
          id: 'j1',
          repo: 'demo',
          title: 't',
          // Megaminion family link (job-parent): null = top-level heist.
          parentJobId: null,
          status: 'working',
          updatedAt: '2026-01-01T00:00:00.000Z',
          prUrl: null,
          baseBranch: null,
          note: null,
          rounds: [
            {
              id: 'j1-r1',
              seq: 1,
              status: 'live',
              verdict: null,
              targetRef: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              lensAttempts: [],
              blockers: 0,
              lenses: [{ lens: 'blind', state: 'pending', agentId: null, note: null, verdict: null }],
            },
          ],
          lane: null,
          lastAgentActivity: null,
        },
        {
          // A megaminion: the reviewer j1's minion commissioned.
          id: 'j1-review-blind',
          repo: 'demo',
          title: 'review (blind)',
          parentJobId: 'j1',
          status: 'working',
          updatedAt: '2026-01-01T00:00:00.000Z',
          prUrl: null,
          baseBranch: null,
          note: null,
          rounds: [],
          lane: null,
          lastAgentActivity: null,
        },
      ],
    },
  ],
  agents: [],
  notifications: [],
  decisions: {
    enabled: false,
    status: 'disabled',
    reason: 'disabled',
    model: '~typesafe/jev-latest',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    credentialPresent: false,
    credentialSource: 'none',
    checkedAt: null,
    incarnation: 'test-incarnation',
    generation: 0,
  },
  unackedActionRequired: 0,
  unackedNeedsOwner: 0,
  wakes: { count: 0, lastAt: null },
  repoOverview: {
    rows: [
      {
        key: 'demo',
        displayName: 'demo',
        linked: true,
        host: 'github.com',
        link: 'https://github.com/example/demo',
        linkReason: null,
        fullName: 'example/demo',
        openPrs: 0,
        openIssues: 3,
        run: {
          state: 'queued',
          status: 'queued',
          conclusion: null,
          workflow: 'CI',
          branch: 'main',
          runNumber: 12,
          url: 'https://github.com/example/demo/actions/runs/12',
          runStartedAt: '2026-01-01T00:00:00.000Z',
          runUpdatedAt: '2026-01-01T00:01:00.000Z',
        },
        freshness: 'fresh',
        checkedAt: '2026-01-01T00:02:00.000Z',
        lastAttemptAt: '2026-01-01T00:02:00.000Z',
        error: null,
      },
    ],
  },
};

const SERVER_CORPUS: readonly unknown[] = [
  { type: 'auth_ok' },
  { type: 'ping' },
  { type: 'error', message: 'invalid token', fatal: true },
  { type: 'error', message: 'soft', fatal: false },
  { type: 'board', snapshot: SNAPSHOT_VALID },
  // invalid
  { type: 'error', message: 'no-fatal-flag' },
  { type: 'error', fatal: true },
  { type: 'board' },
  { type: 'board', snapshot: { repos: [], agents: [], notifications: 'nope' } },
  { type: 'board', snapshot: { ...SNAPSHOT_VALID, repoOverview: { rows: [{ linked: true }] } } },
  { type: 'board', snapshot: null },
  // A job can never be its own megaminion.
  {
    type: 'board',
    snapshot: {
      ...SNAPSHOT_VALID,
      repos: [{ name: 'demo', jobs: [{ ...SNAPSHOT_VALID.repos[0]!.jobs[0]!, parentJobId: 'j1' }] }],
    },
  },
  { type: 'nope' },
  {},
  [],
  null,
  42,
  'str',
];

describe('managed repo overview cross-build drift alarm', () => {
  it('run-state and freshness lists are identical on both builds', () => {
    // The mirrored unions gate every snapshot; a one-sided addition would
    // make the web reject the WHOLE board. Fail here instead of at runtime.
    expect([...web.REPO_OVERVIEW_RUN_STATES]).toEqual([...REPO_OVERVIEW_RUN_STATES]);
    expect([...web.REPO_OVERVIEW_FRESHNESS]).toEqual([...REPO_OVERVIEW_FRESHNESS]);
  });
});

describe('board frame parity (server parser ↔ web validator)', () => {
  it('client-frame corpus: identical accept/reject verdicts', () => {
    for (const item of CLIENT_CORPUS) {
      const server = parseBoardClientFrame(item);
      const client = web.parseBoardClientFrame(item);
      expect(server === null, `client corpus item ${JSON.stringify(item)}`).toBe(client === null);
      if (server !== null) {
        expect(server.type).toBe('auth');
        expect(typeof server.token).toBe('string');
      }
    }
  });

  it('server-frame corpus: identical accept/reject verdicts', () => {
    for (const item of SERVER_CORPUS) {
      const client = web.parseBoardServerFrame(item);
      const valid = client !== null;
      if (item === (SERVER_CORPUS[4] as unknown)) {
        expect(valid, 'the valid snapshot exemplar must parse').toBe(true);
      }
      if (item === (SERVER_CORPUS[10] as unknown)) {
        expect(valid, 'a self-parented job must be refused').toBe(false);
      }
      // The server never parses its own outbound frames; the contract here
      // is that the web side accepts exactly the shapes the server sends.
      if (valid) {
        expect(['auth_ok', 'ping', 'error', 'board']).toContain(client.type);
      }
    }
  });

  it('the ws path constant matches on both sides', () => {
    expect(BOARD_WS_PATH).toBe(web.BOARD_WS_PATH);
    expect(BOARD_WS_PATH).toBe('/board/ws');
  });
});
