/**
 * FOR YOU plain language — the owner-card write boundary (issue #570).
 *
 * Written against modules that exist BEFORE the change (the notification
 * center, the ledger, the decision parser, the attention registry and the
 * web owner-band), so the fail-before leg can overlay these exact bytes on
 * the pre-change base and watch each named assertion fail as an ASSERTION —
 * never as an import or collection error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { NotificationDecision } from '../src/ledger/notification-decision.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { ownerNoticeGuidance } from '../web/src/lib/owner-band.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-for-you-language-'));
  cleanupDirs.push(dir);
  return dir;
}

function boot(): { api: LedgerApi; center: NotificationCenter } {
  const db = new LedgerDb(tmpDir());
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  return { api, center: new NotificationCenter({ ledger: api, bus }) };
}

/** A valid typed decision, so a case can vary exactly the field it is about. */
function card(overrides: Partial<NotificationDecision> = {}): NotificationDecision {
  return {
    question: 'Approve the slim contract?',
    context: 'The agreed product scope would change, and that is your call.',
    recommendation: 'Approve the slim contract.',
    ifNothing: 'If you do nothing, nothing changes and the scope stays as it is.',
    reservedClass: 'scope-design',
    whyNotDelegable: 'It changes the agreed product scope, which is the owner’s call.',
    options: [
      { id: 'approve', label: 'Approve the slim contract', consequence: 'Gru starts the slim plan and reports back.' },
      { id: 'keep', label: 'Keep the current approach', consequence: 'Nothing changes; the work stays parked.' },
    ],
    discussion: false,
    ...overrides,
  };
}

function postOwner(center: NotificationCenter, decision: NotificationDecision): NotificationRecord {
  return center.post({
    kind: 'gru.owner-escalation',
    routing: 'needs-owner',
    severity: 'error',
    title: 'Approve the slim contract?',
    detail: 'Evidence: the agreed scope and the two candidate shapes (ids and paths belong here).',
    decision,
  });
}

describe('FOR YOU plain language — the owner-card write boundary (#570)', () => {
  it('a typed owner decision whose question uses internal vocabulary is refused at the boundary', () => {
    const rig = boot();
    expect(() =>
      postOwner(rig.center, card({ question: 'Gru breaker is open; authorized re-arm required' })),
    ).toThrow(/internal vocabulary/u);
    expect(rig.api.listNotifications({ limit: 10 })).toEqual([]);
  });

  it('a typed owner decision carrying an identifier on its face is refused and the evidence slot is named', () => {
    const rig = boot();
    expect(() =>
      postOwner(rig.center, card({ question: 'head-binding: check-failed for refs/remotes/origin/gru/x — accept?' })),
    ).toThrow(/detail/u);
    expect(rig.api.listNotifications({ limit: 10 })).toEqual([]);
  });

  it('a question card cannot be posted without saying what happens if the owner does nothing', () => {
    const rig = boot();
    const { ifNothing: _omitted, ...withoutDoNothing } = card();
    expect(() => postOwner(rig.center, withoutDoNothing)).toThrow(/does nothing/u);
    expect(rig.api.listNotifications({ limit: 10 })).toEqual([]);
  });

  it('a question card cannot be posted without a recommendation or the explicit no-preference form', () => {
    const rig = boot();
    expect(() => postOwner(rig.center, card({ recommendation: null }))).toThrow(/recommendation/u);
    expect(rig.api.listNotifications({ limit: 10 })).toEqual([]);
  });

  it('an informational notice says nothing is asked of you and what happens if you do nothing', () => {
    // The structured per-kind guidance, which the server boundary requires of
    // any notice kind and the card renders. Before the change this call
    // returned one flat sentence, so there was no why/do-nothing/step triple.
    const informational = ownerNoticeGuidance('worktree-sweep-paused') as unknown as
      | { readonly whyAsked?: string; readonly ifNothing?: string; readonly howTo?: string }
      | null;
    expect(informational?.whyAsked).toContain('Nothing is asked of you');
    expect(informational?.ifNothing).toContain('If you do nothing');

    const port = ownerNoticeGuidance('port-squat') as unknown as
      | { readonly whyAsked?: string; readonly ifNothing?: string; readonly howTo?: string }
      | null;
    expect(port?.whyAsked).toContain('Another program is using the port');
    expect(port?.ifNothing).toContain('If you do nothing');
    expect(port?.howTo).toContain('Stop the program named in Details');
  });
});
