#!/usr/bin/env node
/**
 * Legacy report-job backfill (issue #220) — close out the pre-E19
 * `delivered` lanes the Silas digest still chases as missing PRs.
 *
 * DRY-RUN IS THE DEFAULT and is genuinely read-only: the ledger opens in
 * SQLite readOnly mode and the schema is NEVER migrated, so a dry run can
 * not write even a schema_migrations row. Every legacy row is listed with
 * its proposed outcome. `--apply` opens through the service's
 * migrate-on-boot path (the migration set is forward-only), writes the
 * plan (idempotent — re-running a settled plan is a no-op), records
 * `report.backfilled` per row, and exits nonzero if any row failed. The
 * owner reviews the dry-run list BEFORE any apply.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';
import { LedgerApi } from '../ledger/api.js';
import { LedgerDb } from '../ledger/db.js';
import { applyLegacyReportBackfill, planLegacyReportBackfill } from '../ledger/report-backfill.js';

const USAGE =
  'usage: node dist/cli/report-jobs-backfill.js [--dry-run] [--apply] [--data-dir <path>] [--json]\n' +
  '       (--dry-run is the default and lists proposals without writing; --apply writes)';

interface ParsedArgs {
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly dataDir: string | null;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { apply: boolean; dryRun: boolean; dataDir: string | null; json: boolean } = {
    apply: false,
    dryRun: false,
    dataDir: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--dry-run') {
      // Explicitly accepted: the runbook names the default, so following it
      // verbatim must work. Combining the two is refused below.
      parsed.dryRun = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--data-dir') {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error('--data-dir requires a value');
      parsed.dataDir = value;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (parsed.apply && parsed.dryRun) {
    throw new Error('--apply and --dry-run are mutually exclusive\n' + USAGE);
  }
  return parsed;
}

function renderText(
  ledgerPath: string,
  plan: ReturnType<typeof planLegacyReportBackfill>,
  applied: ReturnType<typeof applyLegacyReportBackfill> | null,
): string {
  const lines: string[] = [];
  lines.push(`ledger: ${ledgerPath}`);
  lines.push(`legacy delivered report jobs: ${plan.proposals.length}`);
  lines.push(`  superseded (provable):  ${plan.superseded}`);
  lines.push(`  obligation to open:     ${plan.obligationOpened}`);
  lines.push(`  listed for the owner:   ${plan.ownerList}`);
  if (applied !== null) {
    lines.push(
      `applied: ${applied.applied} (superseded ${applied.superseded}, obligation-opened ${applied.obligationOpened}), ` +
        `skipped ${applied.skipped}, failed ${applied.failed}`,
    );
  } else {
    lines.push('DRY RUN — nothing written. Review the list, then re-run with --apply.');
  }
  lines.push('');
  for (const proposal of plan.proposals) {
    lines.push(`[${proposal.outcome}] ${proposal.job.id} (status ${proposal.job.status}, deliverable ${String(proposal.job.deliverable)})`);
    lines.push(`    ${proposal.reason}`);
  }
  if (plan.proposals.length === 0) lines.push('no legacy delivered report jobs — nothing to backfill.');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // The instance dir comes from --data-dir (explicit) or the ambient
  // environment/config; tilde expansion resolves against the RUNNING
  // user's home, never a baked-in path.
  const config = args.dataDir === null ? loadConfig() : loadConfig({ GRU_COMMAND_HOME: args.dataDir }, homedir());
  // An explicit --data-dir must BE the ledger's data dir: if the instance
  // config overrides data_dir elsewhere, operating would inspect or modify
  // a different ledger than the caller named. Refuse loudly.
  if (args.dataDir !== null && resolve(config.dataDir) !== resolve(args.dataDir)) {
    throw new Error(
      `--data-dir ${args.dataDir} resolved to data_dir ${config.dataDir} ` +
        `(the instance config at ${join(args.dataDir, 'config.toml')} overrides it) — refusing to operate on a different ledger`,
    );
  }
  const ledgerPath = join(config.dataDir, 'ledger', 'ledger.db');
  // Dry-run is read-only by construction; --apply migrates on open
  // (forward-only), like the service.
  let db: LedgerDb | null = null;
  let readOnly: DatabaseSync | null = null;
  try {
    let ledger: LedgerApi;
    if (args.apply) {
      db = new LedgerDb(config.dataDir);
      ledger = new LedgerApi(db.handle, {});
    } else {
      try {
        readOnly = new DatabaseSync(ledgerPath, { readOnly: true });
      } catch (error) {
        throw new Error(
          `cannot open the ledger read-only at ${ledgerPath} (is the service deployed? use --apply to migrate): ${String(error)}`,
        );
      }
      ledger = new LedgerApi(readOnly, {});
    }
    const plan = planLegacyReportBackfill(ledger);
    const applied = args.apply ? applyLegacyReportBackfill(ledger, plan) : null;
    if (applied !== null && applied.failed > 0) {
      // A partially applied backfill is an incomplete batch: the command
      // contract fails so scripts and the owner's runbook can see it.
      process.exitCode = 1;
    }
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: args.apply ? 'apply' : 'dry-run',
            ledger_path: ledgerPath,
            proposals: plan.proposals.map((proposal) => ({
              job_id: proposal.job.id,
              outcome: proposal.outcome,
              deliverable: proposal.deliverable,
              reason: proposal.reason,
              target_ref: proposal.targetRef,
              target_sha: proposal.targetSha,
            })),
            counts: {
              superseded: plan.superseded,
              obligation_opened: plan.obligationOpened,
              owner_list: plan.ownerList,
            },
            ...(applied === null ? {} : { applied }),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${renderText(ledgerPath, plan, applied)}\n`);
    }
  } finally {
    db?.close();
    readOnly?.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`report-jobs-backfill: ${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  }
}
