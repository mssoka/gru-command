import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardEngine } from '../src/board/engine.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PipelineBoardView } from '../src/ledger/pipeline.js';

/**
 * Board snapshot integration: the durable pipeline block is provider
 * driven (absent on pre-upgrade shapes), server-evaluated, and plain
 * JSON for the socket/HTTP paths.
 */

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function boot(): { ledger: LedgerApi; db: LedgerDb; bus: EventBus } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-board-pipeline-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  return { ledger: new LedgerApi(db.handle, { bus }), db, bus };
}

const CAPACITY = { capacity: 4, occupied: 4, queued: 0, available: 0 };

describe('board snapshot — pipeline block', () => {
  it('stays null when no provider is wired (pre-upgrade shape)', () => {
    const { db, ledger, bus } = boot();
    const engine = new BoardEngine({ ledger, bus });
    expect(engine.snapshot().pipeline).toBeNull();
    db.close();
  });

  it('projects the server-evaluated queue in deterministic order and excludes admitted work', () => {
    const { db, ledger, bus } = boot();
    ledger.enqueuePipelineEntry({ id: 'pipe-b', repoPath: '/tmp/demo', title: 'B', briefing: 'B', priority: 4 });
    ledger.enqueuePipelineEntry({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A', priority: 1 });
    ledger.enqueuePipelineEntry({ id: 'pipe-c', repoPath: '/tmp/demo', title: 'C', briefing: 'C', priority: 9 });
    ledger.claimPipelineEntry({ id: 'pipe-c', holder: 'silas-pipeline' });
    ledger.addJob({ id: 'pipe-c', repo: 'demo', title: 'C', briefing: 'C' });
    ledger.markPipelineAdmitted({ id: 'pipe-c', jobId: 'pipe-c' });

    let view: PipelineBoardView | null = ledger.pipelineBoardView(CAPACITY);
    const engine = new BoardEngine({ ledger, bus, pipeline: () => view });
    const snapshot = engine.snapshot();
    expect(snapshot.pipeline?.entries.map((entry) => entry.id)).toEqual(['pipe-a', 'pipe-b']);
    expect(snapshot.pipeline?.pending).toBe(2);
    expect(snapshot.pipeline?.entries[0]?.state).toBe('ready');
    expect(snapshot.pipeline?.entries[0]?.reason).toContain('resident worker slot');
    // The projection is plain JSON (socket/HTTP serialization).
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    view = null;
    expect(engine.snapshot().pipeline).toBeNull();
    db.close();
  });
});
