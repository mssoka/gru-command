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
];
