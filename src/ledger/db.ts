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
  /**
   * SQLite's standard table-rebuild procedure (create-new, copy, drop,
   * rename) cannot satisfy an immediate FK while a dependent table still
   * references the old table's rows. `foreign_keys` cannot be toggled
   * inside a transaction, so the runner turns it off around this
   * migration's transaction and runs `PRAGMA foreign_key_check` BEFORE
   * COMMIT — a violation rolls the whole migration back loudly, so the
   * window can never commit a broken graph. Set only for migrations that
   * rebuild a table other tables reference.
   */
  readonly foreignKeysOff?: true;
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
    // would risk writing rows a missing migration shaped. A recorded NAME
    // that differs from code means the id was renamed or reused AFTER it
    // was applied: continuing would silently skip the renamed SQL (or die
    // on a duplicate column), so refuse with the mismatch named.
    for (const [id, name] of applied) {
      const coded = migrations.find((m) => m.id === id);
      if (coded === undefined) {
        throw new Error(
          `ledger schema version ${id} is applied but unknown to this build — ` +
            'refusing to run an older binary against a newer ledger',
        );
      }
      if (coded.name !== name) {
        throw new Error(
          `ledger migration ${id} was applied as "${name}" but this build defines ` +
            `"${coded.name}" — refusing to run with a renamed migration`,
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
      // foreign_keys is a no-op mid-transaction: the rebuild flag must be
      // applied BEFORE BEGIN and restored after COMMIT/ROLLBACK.
      const foreignKeysOff = migration.foreignKeysOff === true;
      if (foreignKeysOff) this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.db.exec('BEGIN');
        try {
          this.db.exec(migration.sql);
          if (foreignKeysOff) {
            const violations = this.db.prepare('PRAGMA foreign_key_check').all();
            if (violations.length > 0) {
              throw new Error(
                `migration left ${violations.length} foreign-key violation(s) — refusing to commit a broken graph`,
              );
            }
          }
          this.db
            .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
            .run(migration.id, migration.name, new Date().toISOString());
          this.db.exec('COMMIT');
          ran += 1;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        throw new Error(
          `ledger migration ${migration.id} (${migration.name}) failed: ${String(error)} — rolled back, nothing applied`,
        );
      } finally {
        if (foreignKeysOff) this.db.exec('PRAGMA foreign_keys = ON');
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
    // Sub-minions (issue #161): GC-owned child workers with tracked
    // parentage, idempotent admission and durable results.
    //
    // - `agents.parent_agent_id` is the durable parent link on the child's
    //   own agent row; `agents.parentage` is the honest category marker:
    //   'child' (has a parent), 'top-level' (explicitly parentless),
    //   NULL = legacy/unknown — never reparented from names or job patterns.
    // - `child_workers` is the admission record AND the lifetime creation
    //   counter: one row per LOGICAL child creation. The unique
    //   (parent_agent_id, idempotency_key) index makes a duplicate or
    //   lost-response retry replay the same row (payload-hash conflicts
    //   fail loud), and session resumes/replacement sessions never insert
    //   a second row. Counters are SQL aggregates over this table, so they
    //   survive restart by construction.
    // - `worktrees.kind` gains 'child' (a child lane's owner id is the
    //   child agent id). SQLite cannot alter a CHECK constraint, so the
    //   table is rebuilt in place; the runner's `foreignKeysOff` flag
    //   disables foreign keys around this migration's transaction and
    //   fails loud via `PRAGMA foreign_key_check` before COMMIT (see the
    //   Migration interface), so the rebuild can never commit a broken
    //   graph over worktree_processes' references.
    //
    // LANDING COLLISION (same convention as migrations 10-14): id 15 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    //
    // UPGRADE NOTE (review rounds 2-3): this id was edited while the
    // feature was still unmerged/unshipped. A ledger made by an
    // intermediate commit of this branch (old id-15 shape) is upgraded by
    // the additive migration 16, which backfills the child/agent binding
    // and guarantees the lookup index; the retired capability column is
    // retained here so fresh and upgraded schemas converge. No release
    // build carried either intermediate shape.
    id: 15,
    name: 'child-workers',
    // The worktrees table is rebuilt to widen its kind CHECK; the runner
    // disables foreign keys around this migration and verifies with
    // PRAGMA foreign_key_check before COMMIT (see Migration.foreignKeysOff).
    foreignKeysOff: true,
    sql: `
      CREATE TABLE worktrees_new (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('job','review','child')),
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
        updated_at TEXT NOT NULL,
        base_source TEXT CHECK (base_source IN ('origin','local-head-fallback'))
      );
      INSERT INTO worktrees_new
        (id, kind, repo_path, repo_name, path, branch, sha, job_id, round_id, status, note, created_at, updated_at, base_source)
        SELECT id, kind, repo_path, repo_name, path, branch, sha, job_id, round_id, status, note, created_at, updated_at, base_source
          FROM worktrees;
      DROP TABLE worktrees;
      ALTER TABLE worktrees_new RENAME TO worktrees;
      CREATE INDEX idx_worktrees_job ON worktrees(job_id);
      CREATE INDEX idx_worktrees_round ON worktrees(round_id);
      CREATE INDEX idx_worktrees_status ON worktrees(status);

      ALTER TABLE agents ADD COLUMN parent_agent_id TEXT REFERENCES agents(id);
      ALTER TABLE agents ADD COLUMN parentage TEXT CHECK (parentage IN ('top-level','child'));
      CREATE INDEX idx_agents_parent ON agents(parent_agent_id);
      -- RETIRED (issue #161 round 3): the parent capability is GC-mediated
      -- (in-process native tools), so no bearer column is used by the
      -- code. The column is retained in the schema so a ledger created by
      -- an earlier, unshipped commit of this branch CONVERGES with a fresh
      -- one (a later additive migration must never have to guess which
      -- shape it is upgrading).
      ALTER TABLE agents ADD COLUMN child_request_token_hash TEXT;

      CREATE TABLE child_workers (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT REFERENCES agents(id),
        parent_agent_id TEXT NOT NULL REFERENCES agents(id),
        job_id          TEXT NOT NULL REFERENCES jobs(id),
        purpose         TEXT NOT NULL,
        authority       TEXT NOT NULL CHECK (authority IN ('read-only','writer')),
        task            TEXT NOT NULL,
        label           TEXT,
        idempotency_key TEXT NOT NULL,
        payload_hash    TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('queued','admitted','active','done','error','cancelled')),
        worktree_id     TEXT,
        branch          TEXT,
        session_file    TEXT,
        result_state    TEXT CHECK (result_state IN ('done','error','cancelled')),
        result_summary  TEXT,
        result_ref      TEXT,
        created_at      TEXT NOT NULL,
        admitted_at     TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        updated_at      TEXT NOT NULL,
        UNIQUE (parent_agent_id, idempotency_key)
      );
      CREATE INDEX idx_child_workers_parent ON child_workers(parent_agent_id);
      CREATE INDEX idx_child_workers_job ON child_workers(job_id);
      CREATE INDEX idx_child_workers_state ON child_workers(state);
      CREATE INDEX idx_child_workers_agent ON child_workers(agent_id);
    `,
  },
  {
    // Issue #161 round-3 convergence: an intermediate, unshipped commit of
    // this branch created child_workers rows whose `agent_id` was bound
    // later at spawn (a runtime-minted id) or left NULL. The final model
    // makes `agent_id` equal the admission id from the start, so this
    // additive migration backfills the unbound rows and guarantees the
    // lookup index — a database made by EITHER pre-merge shape upgrades to
    // the same final schema. (Migration 15 keeps the retired capability
    // column for the same convergence reason; nothing reads it.)
    id: 16,
    name: 'child-workers-agent-binding',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_child_workers_agent ON child_workers(agent_id);
      -- The intermediate shape left unspawned rows with NO agent row at
      -- all. Reconstruct the admission agent row BEFORE rebinding, or the
      -- foreign key on child_workers.agent_id would reject the update.
      INSERT INTO agents
        (id, role, label, job_id, round_id, state, last_activity, session_file, parent_agent_id, parentage, created_at, updated_at)
      SELECT cw.id, 'minion', cw.label, cw.job_id, NULL,
             CASE cw.state
               WHEN 'done' THEN 'idle'
               WHEN 'error' THEN 'error'
               WHEN 'cancelled' THEN 'disposed'
               ELSE 'spawning'
             END,
             NULL, cw.session_file, cw.parent_agent_id, 'child', cw.created_at, cw.updated_at
        FROM child_workers cw
       WHERE cw.agent_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = cw.id);
      UPDATE child_workers SET agent_id = id WHERE agent_id IS NULL;
    `,
  },
  {
    // Short heist names (owner-approved display, 2026-09-24): optional
    // authored job label. Renumbered 9 -> 10 -> 11 -> 17 across the main
    // integrations (worktree-base-source id 9; provider-recovery-waits
    // id 10; obligations/child-workers ids 11-16 on main); never applied
    // anywhere before this integration, so the renumber is safe and
    // history-free.
    id: 17,
    name: 'job-display-name',
    sql: 'ALTER TABLE jobs ADD COLUMN display_name TEXT;',
  },
  {
    // Durable approved pipeline queue (owner approvals j-239/j-1064):
    // complete approved executable briefings persist before any worker
    // exists, with a stable id, explicit priority, durable enqueue order,
    // prerequisite ids with explicit milestones, and exclusive scopes.
    // Only the authenticated enqueue boundary writes rows; the state
    // machine (waiting/ready/admitting/admitted/failed/cancelled) keeps
    // every claim atomic and crash-reconcilable. `enqueue_seq` is the
    // durable ordering key (UNIQUE); `request_id` is the idempotency
    // identity and `payload_hash` the changed-replay fence.
    // LANDING COLLISION (same convention as migrations 10–17): this
    // migration was born at branch-local id 14 on this unshipped lane;
    // owner-merged main landed job-amendments 14, child-workers 15,
    // child-workers-agent-binding 16 and job-display-name 17 (crew
    // labels) first, so the never-applied pipeline migration is
    // re-numbered to 18 (never a hole). No ledger outside this unshipped
    // branch ever applied it at an earlier id.
    id: 18,
    name: 'pipeline-entries',
    sql: `
      CREATE TABLE pipeline_entries (
        id               TEXT PRIMARY KEY,
        repo_path        TEXT NOT NULL,
        repo             TEXT NOT NULL,
        title            TEXT NOT NULL,
        briefing         TEXT NOT NULL,
        briefing_hash    TEXT NOT NULL,
        priority         INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 9),
        enqueue_seq      INTEGER NOT NULL UNIQUE,
        state            TEXT NOT NULL CHECK (state IN ('waiting','ready','admitting','admitted','failed','cancelled')),
        hold_reason      TEXT,
        prerequisites    TEXT NOT NULL DEFAULT '[]',
        exclusive_scopes TEXT NOT NULL DEFAULT '[]',
        request_id       TEXT NOT NULL UNIQUE,
        payload_hash     TEXT NOT NULL,
        job_id           TEXT,
        claim            TEXT,
        failure_reason   TEXT,
        failure_count    INTEGER NOT NULL DEFAULT 0,
        reconcile_note   TEXT,
        queued_at        TEXT NOT NULL,
        claimed_at       TEXT,
        admitted_at      TEXT,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX idx_pipeline_entries_state ON pipeline_entries(state);
      CREATE INDEX idx_pipeline_entries_seq ON pipeline_entries(enqueue_seq);
    `,
  },
  {
    // Deliverable kind (E19): implementation lanes owe a PR; review jobs
    // owe findings; artifact and investigation jobs owe a verified
    // handback. The Silas digest uses this so a delivered reviewer's
    // findings handback is never chased as a missing PR.
    id: 19,
    name: 'job-deliverable',
    sql: `ALTER TABLE jobs ADD COLUMN deliverable TEXT;`,
  },
  {
    // Decision memory (issue #218): typed holds and dispositions as state
    // the triggers can read, replacing prose-only memory ("resolved under
    // the existing hold"). Each row names its subject, the signal kinds it
    // covers, the basis fingerprint at decision time and the scheduled
    // re-look; `client_key` makes creates idempotent on retry and `by` is
    // a stored claim (issue #99), never identity proof. Rows are never
    // rewritten: clearing stamps cleared_* and the covering query stops
    // returning the row while history keeps it. Never query this table
    // directly from callers — go through LedgerApi's decision methods so
    // validation and event appends stay on one path.
    id: 20,
    name: 'decisions',
    sql: `
      CREATE TABLE decisions (
        id                TEXT PRIMARY KEY,
        subject           TEXT NOT NULL,   -- 'job:<id>' | 'pr:<repo>#<n>' | 'incident:<kind>:<key>'
        decision          TEXT NOT NULL CHECK (decision IN ('hold','dismissed','acted','superseded','covered')),
        covers            TEXT NOT NULL,   -- JSON array of signal kinds, e.g. ["pr-conflict","ci-failed"]
        basis_fingerprint TEXT,            -- head SHA / incident hash at decision time; NULL = any basis
        reason            TEXT NOT NULL,
        by                TEXT NOT NULL CHECK (by IN ('gru','silas','owner','code')),
        client_key        TEXT UNIQUE,     -- idempotency on retry
        created_at        TEXT NOT NULL,
        recheck_at        TEXT,            -- NULL = no scheduled re-look (still re-opens on basis change)
        cleared_at        TEXT,
        cleared_by        TEXT,
        cleared_reason    TEXT
      );
      CREATE INDEX idx_decisions_subject_active ON decisions(subject, cleared_at);
    `,
  },
  {
    // Report-job closure (issue #220): who commissioned a report-type job
    // (review / artifact / investigation) and what it reviewed. The PR URL
    // (`target_ref`) plus the exact reviewed head (`target_sha`) are the
    // facts the auto-supersede pass reads: a merged target or a head that
    // moved past the reviewed sha retires the owed commissioner decision.
    // NULL on legacy rows — the backfill CLI infers what the ledger can
    // prove and lists the rest for the owner; nothing here guesses.
    // LANDING COLLISION (same convention as migrations 10-20): id 21 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    id: 21,
    name: 'job-report-closure',
    sql: `
      ALTER TABLE jobs ADD COLUMN commissioner TEXT;
      ALTER TABLE jobs ADD COLUMN target_ref TEXT;
      ALTER TABLE jobs ADD COLUMN target_sha TEXT;
      CREATE INDEX idx_jobs_status ON jobs(status);
      CREATE INDEX idx_jobs_pr_url ON jobs(pr_url);
    `,
  },
  {
    // Job family (megaminions): a job commissioned by another job's minion
    // — the build workflow's specialist reviewers — records the commissioning
    // job as its parent so the board nests it under that heist instead of
    // counting it as a peer. One level deep: a child never parents a child.
    // The backfill links only what the ledger proves exactly, and only
    // report-type children under PR-owing parents (so no row can become a
    // grandchild): (1) a commissioner that names a job in the same repo, and
    // (2) a target_ref equal to exactly ONE PR-owing job's pr_url in the
    // same repo. Ambiguous or unmatched rows stay top-level — nothing guessed.
    // LANDING COLLISION (same convention as migrations 10-21): id 22 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    id: 22,
    name: 'job-parent',
    sql: `
      ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id);
      CREATE INDEX idx_jobs_parent ON jobs(parent_job_id);
      UPDATE jobs SET parent_job_id = commissioner
       WHERE deliverable IN ('review', 'artifact', 'investigation')
         AND commissioner IS NOT NULL AND commissioner <> id
         AND EXISTS (
           SELECT 1 FROM jobs parent
            WHERE parent.id = jobs.commissioner AND parent.repo = jobs.repo
              AND (parent.deliverable IS NULL OR parent.deliverable = 'pr')
         );
      UPDATE jobs SET parent_job_id = (
           SELECT parent.id FROM jobs parent
            WHERE parent.pr_url = jobs.target_ref AND parent.repo = jobs.repo
              AND (parent.deliverable IS NULL OR parent.deliverable = 'pr')
         )
       WHERE parent_job_id IS NULL
         AND deliverable IN ('review', 'artifact', 'investigation')
         AND target_ref IS NOT NULL
         AND (
           SELECT COUNT(*) FROM jobs parent
            WHERE parent.pr_url = jobs.target_ref AND parent.repo = jobs.repo
              AND (parent.deliverable IS NULL OR parent.deliverable = 'pr')
         ) = 1;
    `,
  },
  {
    // Guarded interrupted-directive recovery (owner approval j-1348): the
    // terminal `retired` control closure keeps its audit facts and a
    // durable continuation hold on the request row. The hold is released
    // only by a fresh accepted directive/re-brief identity; NULL means
    // open. Additive and nullable: pre-existing rows keep exact meaning.
    // LANDING COLLISION (same convention as migrations 10-22): id 23 is a
    // branch-local next-contiguous number for an UNSHIPPED feature; if
    // owner-merged main lands first, re-number ONLY this never-applied
    // migration (never a hole).
    id: 23,
    name: 'directive-retirement',
    sql: `
      ALTER TABLE pending_directives ADD COLUMN retired_at TEXT;
      ALTER TABLE pending_directives ADD COLUMN retired_by TEXT;
      ALTER TABLE pending_directives ADD COLUMN retire_reason TEXT;
      ALTER TABLE pending_directives ADD COLUMN retire_fingerprint TEXT;
      ALTER TABLE pending_directives ADD COLUMN hold_released_by TEXT;
      ALTER TABLE pending_directives ADD COLUMN hold_released_at TEXT;
      CREATE INDEX idx_pending_directives_hold ON pending_directives(job_id, state, hold_released_by);
    `,
  },
];
