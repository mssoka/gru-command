#!/usr/bin/env node
/**
 * Legacy report-job backfill (issue #220) — close out the pre-E19
 * `delivered` lanes the Silas digest still chases as missing PRs.
 *
 * DRY-RUN IS THE DEFAULT: every legacy row is listed with its proposed
 * outcome and nothing is written. `--apply` writes the plan (idempotent —
 * re-running a settled plan is a no-op) and records `report.backfilled`
 * per row. The owner reviews the dry-run list BEFORE any apply.
 *
 * Runs after the live instance is on the `job-deliverable` migration
 * (deploy main first — the migration set is forward-only and the CLI
 * opens the ledger through the same migrate-on-boot path as the service).
 */
import { loadConfig } from '../config.js';
import { LedgerApi } from '../ledger/api.js';
import { LedgerDb } from '../ledger/db.js';
import { applyLegacyReportBackfill, planLegacyReportBackfill } from '../ledger/report-backfill.js';

const USAGE =
  'usage: node dist/cli/report-jobs-backfill.js [--apply] [--data-dir <path>] [--json]\n' +
  '       (no --apply = dry-run; the default lists proposals and writes nothing)';

interface ParsedArgs {
  readonly apply: boolean;
  readonly dataDir: string | null;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { apply: boolean; dataDir: string | null; json: boolean } = {
    apply: false,
    dataDir: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      parsed.apply = true;
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
  return parsed;
}

function renderText(plan: ReturnType<typeof planLegacyReportBackfill>, applied: ReturnType<typeof applyLegacyReportBackfill> | null): string {
  const lines: string[] = [];
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
  const config = loadConfig(args.dataDir === null ? {} : { GRU_COMMAND_HOME: args.dataDir }, '/home/tester');
  // One explicit decision: the CLI migrates on open (forward-only), like
  // the service. A dry-run performs zero job writes; only --apply writes.
  const db = new LedgerDb(config.dataDir);
  try {
    const ledger = new LedgerApi(db.handle, {});
    const plan = planLegacyReportBackfill(ledger);
    const applied = args.apply ? applyLegacyReportBackfill(ledger, plan) : null;
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: args.apply ? 'apply' : 'dry-run',
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
      process.stdout.write(`${renderText(plan, applied)}\n`);
    }
  } finally {
    db.close();
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
