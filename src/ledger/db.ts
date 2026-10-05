import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * One forward-only migration. `id` numbers are contiguous from 1 — a gap
 * fails the runner (a missing step in history is a bug, not a skip).
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * SQLite ledger storage (EPICS E6 story 1): the durable operational record
 * in the instance data dir (`<data_dir>/ledger/ledger.db`). WAL mode so
 * board reads stay cheap while events append; `node:sqlite` keeps clean
 * clones free of native compile steps.
 */
export class LedgerDb {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly log: Log;
  /** Set once `dispose()` runs — every later statement use throws loudly. */
  private disposed = false;

  constructor(dataDir: string, opts: { log?: Log; migrations?: readonly Migration[] } = {}) {
    this.log = opts.log ?? (() => {});
    const dir = join(dataDir, 'ledger');
    // The ledger carries operational history — owner-only like the rest of
    // the instance data dir.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dbPath = join(dir, 'ledger.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    try {
      this.migrate(opts.migrations ?? MIGRATIONS);
    } catch (error) {
      // A failed boot must not leak the handle: whatever committed before
      // the failure stays durable in the file, the connection closes.
      this.db.close();
      this.disposed = true;
      throw error;
    }
  }

  /** Raw handle for the API layer's prepared statements. */
  get handle(): DatabaseSync {
    if (this.disposed) throw new Error('ledger db disposed');
    return this.db;
  }

  private migrate(migrations: readonly Migration[]): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const applied = new Map<number, string>(
      (
        this.db
          .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
          .all() as { id: number; name: string }[]
      ).map((row) => [row.id, row.name]),
    );

    // Guard 1: every applied version must still exist in code — an unknown
    // version means this binary is OLDER than the database; running on
    // would risk writing rows a missing migration shaped.
    for (const id of applied.keys()) {
      if (!migrations.some((m) => m.id === id)) {
        throw new Error(
          `ledger schema version ${id} is applied but unknown to this build — ` +
            'refusing to run an older binary against a newer ledger',
        );
      }
    }
    // Guard 2: numbering must be contiguous from 1 — a gap is a lost step.
    const ids = migrations.map((m) => m.id).sort((a, b) => a - b);
    ids.forEach((id, index) => {
      if (id !== index + 1) {
        throw new Error(`ledger migrations are not contiguous from 1 (entry ${index + 1} has id ${id})`);
      }
    });

    let ran = 0;
    // Apply in ID order regardless of array order — contiguity alone does
    // not pin application order (an out-of-order array must not reorder
    // history).
    for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
      if (applied.has(migration.id)) continue;
      this.log('info', 'ledger migration applying', { id: migration.id, name: migration.name });
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.id, migration.name, new Date().toISOString());
        this.db.exec('COMMIT');
        ran += 1;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `ledger migration ${migration.id} (${migration.name}) failed: ${String(error)} — rolled back, nothing applied`,
        );
      }
    }
    if (ran === 0) {
      this.log('info', 'ledger schema up to date', {
        migrations: migrations.length,
        applied: applied.size,
      });
    }
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.db.close();
  }
}

/**
 * Schema v1 (E6): jobs, review rounds (with per-lens state), agents, and
 * the append-only events table that feeds the board.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'e6-initial-schema',
    sql: `
      CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        repo        TEXT NOT NULL,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL,
        base_branch TEXT,
        pr_url      TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_repo ON jobs(repo);

      CREATE TABLE rounds (
        id         TEXT PRIMARY KEY,
        job_id     TEXT NOT NULL REFERENCES jobs(id),
        seq        INTEGER NOT NULL,
        status     TEXT NOT NULL,
        target_ref TEXT,
        verdict    TEXT,
        lenses     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (job_id, seq)
      );
      CREATE INDEX idx_rounds_job ON rounds(job_id);

      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        role          TEXT NOT NULL,
        label         TEXT,
        job_id        TEXT REFERENCES jobs(id),
        round_id      TEXT REFERENCES rounds(id),
        state         TEXT NOT NULL,
        last_activity TEXT,
        session_file  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_agents_job ON agents(job_id);
      CREATE INDEX idx_agents_round ON agents(round_id);

      CREATE TABLE lens_states (
        round_id  TEXT NOT NULL REFERENCES rounds(id),
        lens      TEXT NOT NULL,
        state     TEXT NOT NULL,
        agent_id  TEXT,
        note      TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (round_id, lens)
      );

      CREATE TABLE events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        kind     TEXT NOT NULL,
        agent_id TEXT,
        job_id   TEXT,
        round_id TEXT,
        lens     TEXT,
        payload  TEXT NOT NULL
      );
      CREATE INDEX idx_events_kind ON events(kind);
      CREATE INDEX idx_events_job ON events(job_id);
      CREATE INDEX idx_events_round ON events(round_id);
      CREATE INDEX idx_events_agent ON events(agent_id);
    `,
  },
  {
    id: 2,
    name: 'e6-lens-agent-index',
    sql: 'CREATE INDEX idx_lens_agent ON lens_states(agent_id);',
  },
  {
    id: 3,
    name: 'e7-notifications',
    sql: `
      CREATE TABLE notifications (
        id         TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        routing    TEXT NOT NULL,
        severity   TEXT NOT NULL,
        title      TEXT NOT NULL,
        detail     TEXT,
        agent_id   TEXT,
        shown_at   TEXT,
        shown_by   TEXT,
        acked_at   TEXT,
        acked_by   TEXT
      );
      CREATE INDEX idx_notifications_ts ON notifications(ts);
      CREATE INDEX idx_notifications_agent ON notifications(agent_id);
    `,
  },
  {
    id: 4,
    name: 'e8-job-briefing',
    sql: `ALTER TABLE jobs ADD COLUMN briefing TEXT;`,
  },
  {
    id: 5,
    name: 'e8-worktree-registry',
    sql: `
      CREATE TABLE worktrees (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('job','review')),
        repo_path  TEXT NOT NULL,
        repo_name  TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        branch     TEXT,
        sha        TEXT NOT NULL,
        job_id     TEXT REFERENCES jobs(id),
        round_id   TEXT REFERENCES rounds(id),
        status     TEXT NOT NULL CHECK (status IN ('active','paused','swept')),
        note       TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_worktrees_job ON worktrees(job_id);
      CREATE INDEX idx_worktrees_round ON worktrees(round_id);
      CREATE INDEX idx_worktrees_status ON worktrees(status);
    `,
  },
  {
    id: 6,
    name: 'e8-worktree-processes',
    sql: `
      CREATE TABLE worktree_processes (
        worktree_id TEXT NOT NULL REFERENCES worktrees(id),
        pid         INTEGER NOT NULL,
        command     TEXT NOT NULL,
        evidence    TEXT NOT NULL CHECK (evidence IN ('argv','cwd','registry')),
        state       TEXT NOT NULL CHECK (state IN ('live','killed')),
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        PRIMARY KEY (worktree_id, pid)
      );
      CREATE INDEX idx_worktree_processes_wt ON worktree_processes(worktree_id);
    `,
  },
  {
    id: 7,
    name: 'jev-notification-resolution',
    sql: `
      ALTER TABLE notifications ADD COLUMN resolved_at TEXT;
      ALTER TABLE notifications ADD COLUMN resolved_by TEXT;
      CREATE INDEX idx_notifications_kind_active
        ON notifications(kind, resolved_at, acked_at);
    `,
  },
  {
    // Restart-safe re-brief requests: the marker is persisted BEFORE a
    // worker is spawned and clears only when its guarded ledger event
    // lands, so a service restart mid-turn cannot silence the lane.
    id: 8,
    name: 'silas-pending-rebriefs',
    sql: `
      CREATE TABLE pending_rebriefs (
        id           TEXT PRIMARY KEY,
        job_id       TEXT NOT NULL REFERENCES jobs(id),
        kind         TEXT NOT NULL CHECK (kind IN ('silas.rebrief','job.delivered')),
        payload      TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        baseline_seq INTEGER NOT NULL,
        agent_id     TEXT,
        session_file TEXT,
        requested_at TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (job_id, kind)
      );
      CREATE INDEX idx_pending_rebriefs_job ON pending_rebriefs(job_id);
    `,
  },
  {
    // Worktree base provenance (owner incident 2026-09-23): a lane's base
    // sha is only trustworthy when its SOURCE is recorded. 'origin' = the
    // freshly-fetched origin default-branch tip; 'local-head-fallback' =
    // the declared degraded path (the fetch failed, the lane may be stale,
    // and the FYI must be visible). Rows written before this migration
    // keep NULL — a legacy lane's provenance is genuinely unknown.
    id: 9,
    name: 'worktree-base-source',
    sql: `
      ALTER TABLE worktrees ADD COLUMN base_source TEXT
        CHECK (base_source IN ('origin','local-head-fallback'));
    `,
  },
  {
    // Provider-recovery sensor (owner-approved 2026-09-28): durable
    // provider-wait state, per-route probe cadence/budget, and the
    // restart-safe pending recovery delivery marker. Explicit waits only —
    // never inferred from generic blocked status or backlog membership.
    id: 10,
    name: 'provider-recovery-waits',
    sql: `
      CREATE TABLE provider_waits (
        id                      TEXT PRIMARY KEY,
        route_key               TEXT NOT NULL,
        provider                TEXT NOT NULL,
        model                   TEXT NOT NULL,
        endpoint                TEXT NOT NULL,
        credential_fingerprint  TEXT NOT NULL,
        waiter_kind             TEXT NOT NULL CHECK (waiter_kind IN ('job-minion','silas-slot')),
        job_id                  TEXT REFERENCES jobs(id),
        agent_id                TEXT,
        slot_id                 TEXT,
        session_file            TEXT,
        continuation            TEXT,
        job_status_at_establishment TEXT,
        lineage_key             TEXT,
        recovery_batch_id       TEXT,
        incident_id             TEXT NOT NULL,
        incident_generation     INTEGER NOT NULL,
        status                  TEXT NOT NULL CHECK (status IN ('waiting','recovered-pending','claimed','cancelled','superseded')),
        reason_class            TEXT NOT NULL,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      );
      CREATE INDEX idx_provider_waits_route ON provider_waits(route_key, status);
      CREATE INDEX idx_provider_waits_job ON provider_waits(job_id);
      CREATE INDEX idx_provider_waits_agent ON provider_waits(agent_id);

      CREATE TABLE provider_routes (
        route_key                  TEXT PRIMARY KEY,
        provider                   TEXT NOT NULL,
        model                      TEXT NOT NULL,
        endpoint                   TEXT NOT NULL,
        credential_fingerprint     TEXT NOT NULL,
        incident_seq               INTEGER NOT NULL,
        window_start               TEXT NOT NULL,
        attempts_in_window         INTEGER NOT NULL,
        next_check_at              TEXT NOT NULL,
        last_attempt_at            TEXT,
        last_result                TEXT,
        consecutive_probe_failures INTEGER NOT NULL,
        false_recovery_count       INTEGER NOT NULL,
        suspended_until            TEXT,
        updated_at                 TEXT NOT NULL
      );

      CREATE TABLE pending_provider_recovery (
        id                   TEXT PRIMARY KEY,
        route_key            TEXT NOT NULL,
        incident_generation  INTEGER NOT NULL,
        evidence             TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        UNIQUE (route_key, incident_generation)
      );
      CREATE INDEX idx_pending_provider_recovery_route ON pending_provider_recovery(route_key);

      -- Durable PRE-I/O probe reservation (r1 #5): a row exists while a
      -- check is in flight or was interrupted mid-flight; its presence
      -- means the attempt was CHARGED (budget + cadence advanced BEFORE
      -- the network I/O), so a crash can never refund it or issue an
      -- immediate duplicate.
      CREATE TABLE provider_probe_reservations (
        route_key    TEXT PRIMARY KEY,
        reserved_at  TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        outcome      TEXT NOT NULL CHECK (outcome IN ('reserved','spent-unknown'))
      );
    `,
  },
  {
    // Durable follow-through obligations (blocked-heist follow-through,
    // phase 2 — ledger foundation only; no scheduling/execution).
    //
    // LANDING COLLISION RESOLVED (chief ruling 2026-09-28 protocol): main
    // landed migration 9 (worktree-base-source, PR #69) while these
    // never-applied migrations sat unshipped on this branch. They were
    // renumbered 9->10 and 10->11 there, then 10->11, 11->12, 12->13
    // when owner-merged main landed provider-recovery-waits as id 10 —
    // renumbering ONLY never-applied migrations, no hole, no imported
    // schema — and the final head must be reverified/reviewed after
    // integration. Once applied on any
    // database, this build refuses unknown/gapped versions — roll-forward
    // is the only compatible direction (no old-binary compatibility
    // claim, no live schema action).
    //
    // Identity: (job_id, logical_step, incident_key) — stable across
    // duplicate observations; distinct incidents coexist. The partial
    // unique index enforces ONE ACTIVE incarnation per tuple (settled/
    // closed rows are history; a recurrence mints `id#n`); the table-level
    // UNIQUE of the first draft would have rejected every recurrence.
    // `generation` is the job's blocked-generation at creation: only a
    // NEW distinct incident advances it; duplicates never invalidate live
    // work. `plan_revision` bumps ONLY when a duplicate observation
    // changes the plan (next action / authority / wake condition) — the
    // fence that retires claims derived from the older plan.
    // Discriminated unions persist as JSON in TEXT columns, validated in
    // src/ledger/obligations.ts (types are the authority, never prose).
    // `claim_log` keeps the full identity of every prior claim (never a
    // bare counter): expiry alone transfers nothing — the reconciliation
    // path records positive disposition proof there. `receipt_correlation`
    // binds an armed receipt expectation to the delegated phase's actual
    // identity, so a later unrelated event of the same kind cannot
    // satisfy an older expectation.
    id: 11,
    name: 'job-obligations-and-directive-requests',
    sql: `
      CREATE TABLE job_obligations (
        id               TEXT PRIMARY KEY,
        job_id           TEXT NOT NULL REFERENCES jobs(id),
        logical_step     TEXT NOT NULL,
        incident_key     TEXT NOT NULL,
        generation       INTEGER NOT NULL,
        description      TEXT,
        category         TEXT NOT NULL,
        next_action      TEXT NOT NULL,
        wake_condition   TEXT NOT NULL,
        authority        TEXT,
        firing_rule      TEXT NOT NULL,
        state            TEXT NOT NULL,
        settlement       TEXT,
        due_at           TEXT,
        receipt_kind     TEXT,
        deadline_at      TEXT,
        receipt_correlation TEXT,
        recorded_receipts TEXT NOT NULL DEFAULT '[]',
        observations     INTEGER NOT NULL DEFAULT 1,
        plan_revision    INTEGER NOT NULL DEFAULT 0,
        first_origin_seq INTEGER NOT NULL,
        last_origin_seq  INTEGER NOT NULL,
        superseded_by    TEXT,
        claim            TEXT,
        claim_log        TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_job_obligations_active_tuple
        ON job_obligations(job_id, logical_step, incident_key)
        WHERE state IN ('open', 'waiting', 'suspended');
      CREATE INDEX idx_job_obligations_job ON job_obligations(job_id);
      CREATE INDEX idx_job_obligations_state ON job_obligations(state);

      CREATE TABLE pending_directives (
        request_id    TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL REFERENCES jobs(id),
        payload       TEXT NOT NULL,
        payload_hash  TEXT NOT NULL,
        state         TEXT NOT NULL,
        baseline_seq  INTEGER NOT NULL,
        claim         TEXT,
        admission_seq INTEGER,
        admission_minion TEXT,
        delivery_seq  INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 0,
        fail_reason   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_pending_directives_job ON pending_directives(job_id);
      CREATE INDEX idx_pending_directives_state ON pending_directives(state);
    `,
  },
  {
    // Explicit phase-completion handoffs (pr136-chief-handoff): the durable
    // intent an authorized bounded phase persists BEFORE admission/side
    // effects, its validated correlated completion, and the publication
    // record for the owed Gru decision. The debt itself lives in
    // job_obligations; the wake rides NotificationCenter's existing
    // action-required path. `pending_rebriefs.phase_id` binds a re-brief
    // marker pair to its phase row (host-owned identity, never the event
    // sequence). Identity = `phase-handoff:<job>:<source>:<generation>` —
    // generation is per-job monotonic; a replay of the same request returns
    // the same row, a genuinely new phase advances it. `intent_seq` is the
    // events watermark at acceptance: a completion at/before it can never
    // answer this phase (an older receipt cannot complete a newer phase).
    //
    // LANDING COLLISION (same convention as migration 10): id 12 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // another lane's migration lands first, integrate owner-merged main and
    // re-number ONLY this never-applied migration (never a hole).
    id: 12,
    name: 'phase-handoffs',
    sql: `
      CREATE TABLE phase_handoffs (
        phase_id        TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL REFERENCES jobs(id),
        source          TEXT NOT NULL CHECK (source IN ('dispatch','silas-directive','silas-rebrief')),
        request_id      TEXT,
        generation      INTEGER NOT NULL,
        decision        TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('awaiting','completed','closed')),
        intent_seq      INTEGER NOT NULL,
        minion_id       TEXT,
        completion_seq  INTEGER,
        obligation_id   TEXT,
        notification_id TEXT,
        close_reason    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_phase_handoffs_job ON phase_handoffs(job_id);
      CREATE INDEX idx_phase_handoffs_state ON phase_handoffs(state);
      CREATE INDEX idx_phase_handoffs_request ON phase_handoffs(job_id, request_id);

      ALTER TABLE pending_rebriefs ADD COLUMN phase_id TEXT;
    `,
  },
  {
    // Bounded reconcile cursors (PR136 r4 repair, blocker 3): one tiny
    // durable round-robin pointer per reconcile scope. The phase-handoff
    // sweep reads only actionable rows and must still make fair progress
    // across bounded passes — without a persisted cursor a fresh pass
    // re-examines the same prefix and a later owed row never lands.
    // LANDING COLLISION (same convention as migrations 10/11): id 13 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    id: 13,
    name: 'reconcile-cursors',
    sql: `
      CREATE TABLE reconcile_cursors (
        scope      TEXT PRIMARY KEY,
        cursor     INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // Canonical job amendments (owner ruling j-969): append-only versioned
    // acceptance amendments with explicit approval provenance, expected-
    // contract-hash concurrency and idempotency. The original job briefing is
    // never rewritten; later review rounds render the effective contract.
    // LANDING COLLISION (same convention as migrations 10-13): id 14 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    id: 14,
    name: 'job-amendments',
    sql: `
      CREATE TABLE job_amendments (
        id                        TEXT PRIMARY KEY,
        job_id                    TEXT NOT NULL REFERENCES jobs(id),
        version                   INTEGER NOT NULL,
        body                      TEXT NOT NULL,
        body_sha256               TEXT NOT NULL,
        supersedes                TEXT NOT NULL,
        approval_by               TEXT NOT NULL,
        approval_reference        TEXT NOT NULL,
        previous_contract_sha256  TEXT NOT NULL,
        contract_sha256           TEXT NOT NULL,
        request_sha256            TEXT NOT NULL,
        idempotency_key           TEXT,
        created_at                TEXT NOT NULL,
        UNIQUE (job_id, version)
      );
      CREATE INDEX idx_job_amendments_job ON job_amendments(job_id);
      CREATE UNIQUE INDEX idx_job_amendments_idempotency
        ON job_amendments(job_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    // Deliverable kind (owner directive 2026-10-04: no deferred jobs):
    // implementation lanes owe a PR; review jobs owe findings; artifact
    // and investigation jobs owe a verified handback. The Silas digest
    // uses this to stop classifying non-PR deliverables as PR-overdue.
    id: 15,
    name: 'e15-job-deliverable',
    sql: `ALTER TABLE jobs ADD COLUMN deliverable TEXT;`,
  },
  {
    // Parent relation (E16, round-3 finding 4): a reviewer job records
    // the lane that commissioned it, so its delivery can re-arm the
    // parent (collect findings, continue the cycle) instead of leaving
    // the parent parked with no machine-visible follow-up.
    id: 16,
    name: 'e16-job-parent',
    sql: `ALTER TABLE jobs ADD COLUMN parent_job_id TEXT;`,
  },
];
