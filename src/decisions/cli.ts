#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_DECISION_PROFILE,
  effectiveDecisionProviders,
  loadConfig,
  ConfigError,
  instanceDirFromEnv,
} from '../config.js';
import { decisionsConfigTemplate } from './config-template.js';
import {
  parseCredentialStdin,
  resolveCredential,
  writeCredential,
} from './credentials.js';
import { CREDENTIAL_SLOTS, KEYLESS_CREDENTIAL, type CredentialSlot } from './profile.js';
import { checkDecisionProfile, DecisionRuntime } from './runtime.js';
import {
  backtestRecordFromReport,
  defaultCasesPath,
  readCasesJsonl,
  runBacktest,
  saveBacktestRecord,
  writeCasesJsonl,
} from './backtest.js';
import { BACKTEST_SURFACES, surfaceCaseSpec } from './cases/registry.js';
import { extractEscalationTriageCases } from './cases/escalation-triage-extract.js';
import { extractSameBlockerCases } from './cases/same-blocker-extract.js';
import { extractReportConclusionCases } from './cases/report-conclusion-extract.js';

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code = 2): number {
  process.stderr.write(`${message}\n`);
  return code;
}

async function readStdin(maxBytes = 16_384): Promise<string> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    seen += buffer.length;
    if (seen > maxBytes) throw new Error('credential input is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Offline, sanitised status: legacy top-level fields plus one entry per
 * effective profile (built-ins included). The top-level credential fields
 * describe the DEFAULT profile's slot (today's single-slot semantics), so
 * an overridden default reports its own slot — never hardcoded OpenRouter.
 * No key material ever leaves. */
function offlineStatus(): number {
  const config = loadConfig();
  const effective = effectiveDecisionProviders(config.decisions);
  const defaultSlot = effective[DEFAULT_DECISION_PROFILE]?.credential ?? 'openrouter';
  const credential =
    defaultSlot === KEYLESS_CREDENTIAL
      ? { state: 'present' as const, source: 'none' as const }
      : resolveCredential(config.instanceDir, process.env, defaultSlot);
  const profiles = Object.entries(effective).map(([name, profile]) => {
    if (profile.credential === KEYLESS_CREDENTIAL) {
      return {
        name,
        protocol: profile.protocol,
        endpoint: profile.endpoint,
        model: profile.model,
        credential: KEYLESS_CREDENTIAL,
        credential_state: 'present',
        credential_source: 'none',
      };
    }
    const resolved = resolveCredential(config.instanceDir, process.env, profile.credential);
    return {
      name,
      protocol: profile.protocol,
      endpoint: profile.endpoint,
      model: profile.model,
      credential: profile.credential,
      credential_state: resolved.state,
      credential_source: resolved.source,
    };
  });
  json({
    enabled: config.decisions.jev.enabled,
    credential_present: credential.state === 'present',
    credential_source: credential.source,
    credential_state: credential.state,
    profiles,
  });
  return 0;
}

async function check(profileName: string | null, asJson: boolean): Promise<number> {
  const config = loadConfig();
  const name = profileName ?? DEFAULT_DECISION_PROFILE;
  if (profileName === null) {
    // Default profile: the full runtime startup probe (existing behavior).
    if (!config.decisions.jev.enabled) {
      if (asJson) json({ ok: true, status: 'disabled', reason: null });
      else process.stdout.write(`${name}: disabled (the [decisions] master switch is off)\n`);
      return 0;
    }
    const runtime = new DecisionRuntime(config.decisions, {
      instanceDir: config.instanceDir,
      watchConfig: false,
    });
    try {
      const status = await runtime.start();
      const ok = status.status === 'ready';
      if (asJson) json({ ok, status: status.status, reason: status.reason });
      else process.stdout.write(`${name}: ${status.status}${status.reason !== null ? ` (${status.reason})` : ''}\n`);
      return ok ? 0 : 1;
    } finally {
      runtime.dispose();
    }
  }
  // A named profile validates its existence FIRST — a master-switch-off
  // check of a misspelled profile is a failed check, not a clean disabled.
  const result = await checkDecisionProfile(config.decisions, name, {
    instanceDir: config.instanceDir,
    env: process.env,
  });
  if (asJson) json({ ok: result.ok, status: result.status, reason: result.reason, profile: result.profile });
  else {
    process.stdout.write(
      `${name}: ${result.status}${result.reason !== null ? ` (${result.reason})` : ''}${result.model !== null ? ` model=${result.model}` : ''}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

/** Parse `check` flags: optional `--json` and optional `--profile <name>`,
 * in any order. */
function parseCheckArgs(rest: readonly string[]): { profile: string | null; json: boolean } | string {
  let profile: string | null = null;
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      asJson = true;
    } else if (arg === '--profile') {
      const value = rest[i + 1];
      if (value === undefined) return 'usage: check [--json] [--profile <name>]';
      profile = value;
      i += 1;
    } else {
      return 'usage: check [--json] [--profile <name>]';
    }
  }
  return { profile, json: asJson };
}

// ------------------------------------------------------------------
// backtest + extract-cases (issue #223)
// ------------------------------------------------------------------

const BACKTEST_USAGE =
  'usage: backtest --surface <name> --profile <name> [--cases <jsonl>] [--record <dir>] [--replay <dir>] [--threshold <min>] [--threshold-metric <agreement|precision|recall>] [--save]';
const EXTRACT_USAGE =
  'usage: extract-cases --surface <name> --out <jsonl> [--ledger-db <path>] [--artifact-root <dir>]';

interface BacktestArgs {
  readonly surface: string;
  readonly profile: string;
  readonly cases: string | null;
  readonly record: string | null;
  readonly replay: string | null;
  readonly threshold: number | null;
  readonly thresholdMetric: 'agreement' | 'precision' | 'recall';
  readonly save: boolean;
}

function parseBacktestArgs(rest: readonly string[]): BacktestArgs | string {
  const parsed: {
    surface: string | null; profile: string | null; cases: string | null;
    record: string | null; replay: string | null; threshold: number | null;
    thresholdMetric: 'agreement' | 'precision' | 'recall'; save: boolean;
  } = {
    surface: null, profile: null, cases: null, record: null, replay: null,
    threshold: null, thresholdMetric: 'precision', save: false,
  };
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case '--surface': {
        const value = rest[i + 1];
        if (value === undefined) return BACKTEST_USAGE;
        parsed.surface = value;
        i += 1;
        break;
      }
      case '--profile': {
        const value = rest[i + 1];
        if (value === undefined) return BACKTEST_USAGE;
        parsed.profile = value;
        i += 1;
        break;
      }
      case '--cases': {
        const value = rest[i + 1];
        if (value === undefined) return BACKTEST_USAGE;
        parsed.cases = value;
        i += 1;
        break;
      }
      case '--record': {
        const value = rest[i + 1];
        if (value === undefined) return BACKTEST_USAGE;
        parsed.record = value;
        i += 1;
        break;
      }
      case '--replay': {
        const value = rest[i + 1];
        if (value === undefined) return BACKTEST_USAGE;
        parsed.replay = value;
        i += 1;
        break;
      }
      case '--threshold': {
        const raw = rest[i + 1];
        if (raw === undefined) return BACKTEST_USAGE;
        const threshold = Number(raw);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          return '--threshold must be a number between 0 and 1';
        }
        parsed.threshold = threshold;
        i += 1;
        break;
      }
      case '--threshold-metric': {
        const metric = rest[i + 1];
        if (metric === undefined) return BACKTEST_USAGE;
        if (metric !== 'agreement' && metric !== 'precision' && metric !== 'recall') {
          return '--threshold-metric must be one of: agreement, precision, recall';
        }
        parsed.thresholdMetric = metric;
        i += 1;
        break;
      }
      case '--save':
        parsed.save = true;
        break;
      default:
        return BACKTEST_USAGE;
    }
  }
  if (parsed.surface === null || parsed.profile === null) return BACKTEST_USAGE;
  if (parsed.record !== null && parsed.replay !== null) return '--record and --replay are mutually exclusive';
  return { ...parsed, surface: parsed.surface, profile: parsed.profile };
}

async function backtest(args: BacktestArgs): Promise<number> {
  if (!BACKTEST_SURFACES.includes(args.surface)) {
    return fail(`unknown backtest surface "${args.surface}" (registered: ${BACKTEST_SURFACES.join(', ')})`);
  }
  const spec = surfaceCaseSpec(args.surface);
  const config = loadConfig();
  const casesPath = args.cases ?? defaultCasesPath(config.dataDir, args.surface);
  const cases = readCasesJsonl(casesPath);
  const labels = new Set(spec.labels);
  const unknown = cases.filter((testCase) => !labels.has(testCase.label));
  if (unknown.length > 0) {
    return fail(
      `case file ${casesPath} carries labels outside the ${args.surface} vocabulary (${spec.labels.join(', ')}): ` +
      [...new Set(unknown.map((testCase) => testCase.label))].join(', '),
    );
  }
  const report = await runBacktest({
    surface: args.surface,
    profileName: args.profile,
    cases,
    config: config.decisions,
    instanceDir: config.instanceDir,
    env: process.env,
    ...(args.record !== null ? { recordDir: args.record } : {}),
    ...(args.replay !== null ? { replayDir: args.replay } : {}),
  });
  if (args.save) {
    if (args.threshold === null) {
      return fail('--save requires a --threshold <min>: evidence is only recorded together with its stated threshold');
    }
    const record = backtestRecordFromReport(report, { metric: args.thresholdMetric, label: null, min: args.threshold });
    const path = saveBacktestRecord(config.dataDir, record);
    json({ report, saved: path });
    return record.met ? 0 : 1;
  }
  json({ report });
  return 0;
}

interface ExtractArgs {
  readonly surface: string;
  readonly out: string | null;
  readonly ledgerDb: string | null;
  readonly artifactRoot: string | null;
}

function parseExtractArgs(rest: readonly string[]): ExtractArgs | string {
  const parsed: { surface: string | null; out: string | null; ledgerDb: string | null; artifactRoot: string | null } = {
    surface: null, out: null, ledgerDb: null, artifactRoot: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    switch (flag) {
      case '--surface':
      case '--out':
      case '--ledger-db':
      case '--artifact-root': {
        if (value === undefined) return EXTRACT_USAGE;
        const key = { '--surface': 'surface', '--out': 'out', '--ledger-db': 'ledgerDb', '--artifact-root': 'artifactRoot' }[flag] as
          | 'surface' | 'out' | 'ledgerDb' | 'artifactRoot';
        parsed[key] = value;
        i += 1;
        break;
      }
      default:
        return EXTRACT_USAGE;
    }
  }
  if (parsed.surface === null) return EXTRACT_USAGE;
  return parsed as ExtractArgs;
}

async function extractCases(args: ExtractArgs): Promise<number> {
  const config = loadConfig();
  const outPath = args.out ?? defaultCasesPath(config.dataDir, args.surface);
  let cases: ReturnType<typeof extractEscalationTriageCases>;
  try {
    switch (args.surface) {
      case 'escalation_triage': {
        const dbPath = args.ledgerDb ?? resolve(config.dataDir, 'ledger', 'ledger.db');
        // Dynamic import: ordinary decisions subcommands must not load
        // node:sqlite (its experimental warning would pollute stderr).
        const { DatabaseSync } = await import('node:sqlite');
        let db: InstanceType<typeof DatabaseSync>;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
        } catch (error) {
          return fail(`cannot open ledger read-only at ${dbPath}: ${(error as Error).message}`);
        }
        try {
          cases = extractEscalationTriageCases(db);
        } finally {
          db.close();
        }
        break;
      }
      case 'same_blocker': {
        if (args.artifactRoot === null) return fail('extract-cases --surface same_blocker requires --artifact-root <dir>');
        cases = extractSameBlockerCases(args.artifactRoot);
        break;
      }
      case 'report_conclusion': {
        if (args.artifactRoot === null) return fail('extract-cases --surface report_conclusion requires --artifact-root <dir>');
        cases = extractReportConclusionCases(args.artifactRoot);
        break;
      }
      default:
        return fail(`unknown extract surface "${args.surface}" (registered: ${BACKTEST_SURFACES.join(', ')})`);
    }
  } catch (error) {
    return fail(`case extraction failed: ${(error as Error).message}`);
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeCasesJsonl(outPath, cases);
  json({ surface: args.surface, out: outPath, n: cases.length });
  return 0;
}

function parseSlot(rest: readonly string[]): { readonly ok: true; readonly slot: CredentialSlot } | { readonly ok: false; readonly message: string } {
  // `credentials set --stdin` (legacy, openrouter slot) or
  // `credentials set --slot <name> --stdin`.
  if (rest[0] !== 'set') {
    return { ok: false, message: 'usage: credentials set [--slot <name>] --stdin (API keys are never accepted in argv)' };
  }
  const args = rest.slice(1);
  if (args.length === 1 && args[0] === '--stdin') return { ok: true, slot: 'openrouter' };
  if (args.length === 3 && args[0] === '--slot' && args[2] === '--stdin') {
    const slot: string = args[1] ?? '';
    if (!(CREDENTIAL_SLOTS as readonly string[]).includes(slot)) {
      return { ok: false, message: `unknown credential slot "${slot}" (valid: ${CREDENTIAL_SLOTS.join(', ')})` };
    }
    return { ok: true, slot: slot as CredentialSlot };
  }
  return { ok: false, message: 'usage: credentials set [--slot <name>] --stdin (API keys are never accepted in argv)' };
}

export async function runDecisionCli(argv: readonly string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'config-template') {
      let enabled = false;
      if (rest.length > 0) {
        if (rest.length !== 2 || rest[0] !== '--enabled' || (rest[1] !== 'true' && rest[1] !== 'false')) {
          return fail('usage: config-template [--enabled true|false]');
        }
        enabled = rest[1] === 'true';
      }
      process.stdout.write(decisionsConfigTemplate(enabled));
      return 0;
    }
    if (command === 'credentials') {
      const parsed = parseSlot(rest);
      if (!parsed.ok) return fail(parsed.message);
      const key = parseCredentialStdin(await readStdin());
      writeCredential(instanceDirFromEnv(), key, parsed.slot);
      json({ ok: true });
      return 0;
    }
    if (command === 'status') {
      if (rest.length !== 1 || rest[0] !== '--json') return fail('usage: status --json');
      return offlineStatus();
    }
    if (command === 'check') {
      const parsed = parseCheckArgs(rest);
      if (typeof parsed === 'string') return fail(parsed);
      return await check(parsed.profile, parsed.json);
    }
    if (command === 'backtest') {
      const parsed = parseBacktestArgs(rest);
      if (typeof parsed === 'string') return fail(parsed);
      return await backtest(parsed);
    }
    if (command === 'extract-cases') {
      const parsed = parseExtractArgs(rest);
      if (typeof parsed === 'string') return fail(parsed);
      return await extractCases(parsed);
    }
    return fail('usage: <backtest|check|config-template|credentials|extract-cases|status> (secrets are stdin-only)');
  } catch (error) {
    if (error instanceof ConfigError) return fail('configuration is invalid; fix config.toml and retry', 1);
    const message = error instanceof Error && /credential|profile/i.test(error.message)
      ? error.message
      : 'decision command failed; inspect local file permissions/config and retry';
    return fail(message, 1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDecisionCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('decision command failed\n');
      process.exitCode = 1;
    });
}
