#!/usr/bin/env node
/**
 * GH350 property capability report — read-only resolution of the
 * property-testing tooling a TARGET repository/package actually has
 * (declared/locked/installed/runnable), printed as explicit typed rows.
 * Statuses are honest data: exit 0 whenever the report completed, 2 for
 * usage errors, 1 for operational failure. Never installs, never writes.
 */
import { resolvePropertyCapabilities, ResolutionWalkError } from '../property/resolve.js';
import type { PackageResolution } from '../property/types.js';

const USAGE = 'usage: node dist/cli/property-report.js <repo-path> [--scope path[,path…]] [--json]';

export interface ParsedArgs {
  readonly repo: string | null;
  readonly scope: readonly string[] | null;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { repo: string | null; scope: string[] | null; json: boolean } = { repo: null, scope: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--json') {
      parsed.json = true;
      continue;
    }
    if (argument === '--scope') {
      const value = argv[index + 1];
      if (value === undefined || value === '') throw new UsageError('--scope requires a comma-separated path list');
      parsed.scope = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new UsageError(`unknown option: ${argument}`);
    if (parsed.repo !== null) throw new UsageError('exactly one repository path is required');
    parsed.repo = argument;
  }
  if (parsed.repo === null || parsed.repo === '') throw new UsageError('a repository path is required');
  return parsed;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function renderRow(row: PackageResolution): readonly string[] {
  const lines = [
    `package: ${row.packageDir}`,
    `  ecosystem: ${row.ecosystem ?? 'none'}`,
    `  status: ${row.status}${row.adapterId === null ? '' : ` (adapter ${row.adapterId})`}`,
  ];
  if (row.tooling !== null) {
    lines.push(
      `  tooling: runner=${row.tooling.runner} libraries=${JSON.stringify(row.tooling.libraries)} executable=${String(row.tooling.executable)}`,
    );
    for (const reason of row.tooling.reasons) lines.push(`    ladder: ${reason}`);
  }
  for (const reason of row.reasons) lines.push(`  reason: ${reason}`);
  lines.push(`  resolutionKey: ${row.resolutionKey}`);
  for (const entry of row.evidence) lines.push(`  evidence: ${entry.role} ${entry.path} sha256=${entry.sha256}`);
  return lines;
}

export function renderReport(report: ReturnType<typeof resolvePropertyCapabilities>): string {
  return [
    `property capability report for ${report.repoRoot}${report.scoped ? ' (scoped)' : ''}`,
    ...report.packages.flatMap(renderRow),
  ].join('\n');
}

export interface ReportRun {
  readonly exitCode: number;
  readonly stdout: string;
}

export async function runPropertyReport(argv: readonly string[]): Promise<ReportRun> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return { exitCode: 2, stdout: `${USAGE}\n${error.message}` };
    throw error;
  }
  const repo = args.repo;
  if (repo === null) return { exitCode: 2, stdout: `${USAGE}\na repository path is required` };
  try {
    const report = resolvePropertyCapabilities({ repoRoot: repo, scopePaths: args.scope ?? undefined });
    return { exitCode: 0, stdout: args.json ? JSON.stringify(report, null, 2) : renderReport(report) };
  } catch (error) {
    if (error instanceof ResolutionWalkError) {
      return { exitCode: 1, stdout: `operational failure: ${error.message}` };
    }
    return { exitCode: 1, stdout: `operational failure: ${String(error)}` };
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('property-report.js')) {
  void runPropertyReport(process.argv.slice(2)).then((run) => {
    process.stdout.write(`${run.stdout}\n`);
    process.exit(run.exitCode);
  });
}
