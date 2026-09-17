import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';

/**
 * Notification system tests (EPICS E7 story 2): the durable log, FYI
 * derivation from board events (once, at event time), display receipts
 * (shown:true doctrine — idempotent per surface), the human ack, and the
 * action-required chat callback.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-notifications-'));
  cleanupDirs.push(dir);
  return dir;
}

interface Rig {
  api: LedgerApi;
  bus: EventBus;
  center: NotificationCenter;
  actionRequired: NotificationRecord[];
}

function boot(): Rig {
  const db = new LedgerDb(tmpDir());
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const actionRequired: NotificationRecord[] = [];
  const center = new NotificationCenter({
    ledger: api,
    bus,
    onActionRequired: (notification) => actionRequired.push(notification),
  });
  return { api, bus, center, actionRequired };
}

describe('notification center — durable log + receipts + acks', () => {
  let rig: Rig;
  beforeAll(() => {
    rig = boot();
  });

  it('posts rows durably with kind/routing/severity; ids are unique ack ids', () => {
    const row = rig.center.post({
      kind: 'supervision.hang',
      routing: 'fyi',
      severity: 'error',
      title: 'Agent a1: turn hang',
      detail: 'silence 900s',
      agentId: 'a1',
    });
    expect(row.id).not.toBe('');
    const fetched = rig.api.getNotification(row.id);
    expect(fetched?.routing).toBe('fyi');
    expect(fetched?.severity).toBe('error');
    expect(fetched?.shownAt).toBeNull();
    expect(fetched?.ackedAt).toBeNull();
  });

  it('shown receipts are idempotent per surface — one event, never spam', () => {
    const row = rig.center.post({
      kind: 'test.shown',
      routing: 'fyi',
      severity: 'info',
      title: 'receipt test',
    });
    rig.center.markShown(row.id, 'web-toast');
    rig.center.markShown(row.id, 'web-toast'); // repeat: no-op
    rig.center.markShown(row.id, 'web-toast'); // repeat: no-op
    const afterFirst = rig.api.getNotification(row.id);
    expect(afterFirst?.shownAt).not.toBeNull();
    expect(afterFirst?.shownBy).toBe('web-toast');
    const shownEvents = rig.api
      .listEvents({ limit: 100 })
      .filter((e) => e.kind === 'notification.shown' && (e.payload as { id: string }).id === row.id);
    expect(shownEvents.length).toBe(1);
    // A DIFFERENT surface upgrades the receipt.
    rig.center.markShown(row.id, 'browser');
    const upgraded = rig.api.getNotification(row.id);
    expect(upgraded?.shownBy).toBe('browser,web-toast');
    expect(rig.api.getNotification(row.id)?.shownBy?.split(',').length).toBe(2);
  });

  it('ack round-trip: human ack persists, echoes on the bus, and is idempotent', () => {
    const seen: string[] = [];
    rig.bus.subscribe((event) => {
      if (event.kind === 'notification.acked') seen.push((event.payload as { id: string }).id);
    });
    const row = rig.center.post({
      kind: 'supervision.breaker',
      routing: 'action-required',
      severity: 'error',
      title: 'Crash-loop breaker tripped: agent a2 stopped',
      detail: 'ack to re-arm',
      agentId: 'a2',
    });
    // Action-required rows fire the chat-surface callback (SPEC ruling 13).
    expect(rig.actionRequired.map((n) => n.id)).toContain(row.id);
    const acked = rig.center.ack(row.id, 'web');
    expect(acked?.ackedAt).not.toBeNull();
    expect(acked?.ackedBy).toBe('web');
    expect(seen).toContain(row.id);
    rig.center.ack(row.id, 'web'); // idempotent — one event
    const ackEvents = rig.api
      .listEvents({ limit: 100 })
      .filter((e) => e.kind === 'notification.acked' && (e.payload as { id: string }).id === row.id);
    expect(ackEvents.length).toBe(1);
    // Unknown ids are a clean null (HTTP maps to 404).
    expect(rig.center.markShown('nope', 'web')).toBeNull();
    expect(rig.center.ack('nope', 'web')).toBeNull();
  });

  it('FYI derivation: board-worthy events post exactly once, at event time', () => {
    const rig2 = boot();
    // A job transitions to blocked (via the legal machine).
    rig2.api.addJob({ id: 'j1', repo: 'demo', title: 'Derivation job' });
    rig2.api.setJobStatus('j1', 'working');
    rig2.api.setJobStatus('j1', 'blocked');
    let blockedRows = rig2.api.listNotifications({ limit: 50 }).filter((n) => n.title.includes('j1'));
    expect(blockedRows.length).toBe(1);
    expect(blockedRows[0]?.routing).toBe('fyi');
    // Repeated snapshots NEVER derive again — the row is the feed.
    for (let i = 0; i < 5; i += 1) {
      rig2.api.listNotifications({ limit: 50 });
      rig2.bus.publish({ seq: 0, ts: new Date().toISOString(), kind: 'noise', agentId: null, jobId: null, roundId: null, lens: null, payload: {} });
    }
    blockedRows = rig2.api.listNotifications({ limit: 50 }).filter((n) => n.title.includes('j1'));
    expect(blockedRows.length).toBe(1);
    // A verdict derives as info severity (round goes live → verdict).
    const round = rig2.api.addRound({ jobId: 'j1' });
    rig2.api.setRoundStatus(round.id, 'live');
    rig2.api.setRoundVerdict(round.id, 'approved');
    const verdictRows = rig2.api.listNotifications({ limit: 50 }).filter((n) => n.kind === 'round.verdict');
    expect(verdictRows.length).toBe(1);
    expect(verdictRows[0]?.severity).toBe('info');
  });

  it('unackedOnly filters the pending surface (badge feed)', () => {
    const rig3 = boot();
    const a = rig3.center.post({ kind: 't.a', routing: 'fyi', severity: 'info', title: 'A' });
    const b = rig3.center.post({ kind: 't.b', routing: 'action-required', severity: 'error', title: 'B' });
    rig3.center.ack(b.id, 'web');
    const unacked = rig3.api.listNotifications({ limit: 10, unackedOnly: true });
    expect(unacked.map((n) => n.id)).toEqual([a.id]);
  });
});
