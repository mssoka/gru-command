#!/usr/bin/env node
// Mutation record for the creation-continuation restart and client-abort
// tests (#503, creation-continuation finding 4d).
//
// For each mutation this extracts the committed HEAD into a scratch directory
// (node_modules linked), applies ONE edit set to production source, runs the
// tests that cover it, and requires every test in `fails` to fail and every
// test in `holds` to still pass. Edited files are compared byte for byte with
// HEAD afterwards. No tracked file in the working tree is touched; the idempotent
// vitest RPC-timeout patch (the lane scopes' own prerequisite) is applied through
// the linked node_modules.
//
//   node gru-output/gc-503-p1-restart/mutations.mjs [--only R1,A1] [--check]
//
// Exit 0 only when the unmutated baseline passes and every mutation is killed
// by the tests it names. Run through the `gc-503-p1-mutations` verify scope
// (the lane's declared scheduler entry).
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const print = (text) => process.stdout.write(`${text}\n`);

const root = process.cwd();
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;

const FILE = 'test/creation-continuation.test.ts';
const RESTART = 'across a real ledger close and reopen';
const ABORT = 'when the client aborts during the held inspection';
// The two restart tests that share ONE open ledger across their "restart".
const SAME_LEDGER_ACCEPTED = 'turns a durable accepted request without a live owner into custody-unknown after restart';
const SAME_LEDGER_ADMITTED = 'reports an admitted-but-undelivered owner lost on restart as unknown';
const SHARED_LEDGER_TESTS = [SAME_LEDGER_ACCEPTED, SAME_LEDGER_ADMITTED];

const API = 'src/ledger/api.ts';
const SERVICE = 'src/dispatch/service.ts';

// Anchors (each must match exactly once at HEAD; `--check` proves it).
const APPEND_EVENT = "    const info = this.db\n      .prepare(\n        `INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload)";
const CONTINUATION_READ = ".all(...(requestId === undefined ? [jobId] : [jobId, requestId]) as string[]) as Row[]).map((row) => this.eventFromRow(row));";
const SERVICE_EARLY_RETURN = "    if (existing !== null) return { created: false, readback: this.creationContinuationReadback(existing) };\n";
const LEDGER_DEDUPE = "      const prior = byRequest.get(input.requestId);\n      if (prior !== undefined) {";

/** The write of one `job.creation-continuation` stage is skipped in SQLite and
 * kept in a process-local list that the reader merges back in: the fact is
 * visible for as long as this LedgerApi lives and gone after a close/reopen. */
function heldInMemory(stage, seq) {
  return [
    { file: API, find: APPEND_EVENT, replace: [
      `    if (fields.kind === 'job.creation-continuation' && (fields.payload as { stage?: string }).stage === '${stage}') {`,
      '      const memory = ((this as unknown as { memoryOnly?: unknown[] }).memoryOnly ??= []);',
      `      const held = { seq: ${seq}, ts, kind: fields.kind, agentId: null, jobId: fields.jobId ?? null, roundId: null, lens: null, payload: fields.payload ?? {} };`,
      '      memory.push(held);',
      '      return held as unknown as BusEvent;',
      '    }',
      APPEND_EVENT,
    ].join('\n') },
    { file: API, find: CONTINUATION_READ, replace: [
      ".all(...(requestId === undefined ? [jobId] : [jobId, requestId]) as string[]) as Row[]).map((row) => this.eventFromRow(row))",
      '      .concat(((this as unknown as { memoryOnly?: EventRecord[] }).memoryOnly ?? [])',
      "        .filter((event) => event.jobId === jobId && (requestId === undefined || (event.payload as Record<string, unknown>)['request_id'] === requestId)))",
      '      .sort((a, b) => a.seq - b.seq);',
    ].join('\n') },
  ];
}

/** id, what is disabled, the edits, the tests that must fail, the tests that must still pass. */
const MUTATIONS = [
  { id: 'R1', what: 'the acceptance record of a request is written to process memory only (never to SQLite)',
    edits: heldInMemory('accepted', -1), fails: [RESTART], holds: SHARED_LEDGER_TESTS },
  { id: 'R2', what: "the spawn-admission stage record ('minion-spawned') of a request is written to process memory only",
    edits: heldInMemory('minion-spawned', 'Number.MAX_SAFE_INTEGER'), fails: [RESTART], holds: SHARED_LEDGER_TESTS },
  { id: 'A1', what: 'a retry of an already recorded request id is recorded as a new request (neither the service nor the ledger recognizes the id)',
    edits: [
      { file: SERVICE, find: SERVICE_EARLY_RETURN, replace: '' },
      { file: API, find: LEDGER_DEDUPE, replace: "      const prior = undefined as EventRecord[] | undefined;\n      if (prior !== undefined) {" },
    ], fails: [ABORT], holds: [] },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Run the creation-continuation suite filtered to `names` in the scratch tree. */
function runNames(dir, names) {
  const out = join(dir, `.mutation-${Math.random().toString(36).slice(2)}.json`);
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.heavy.config.ts', '--reporter=json', '--outputFile', out, FILE,
    '-t', names.map(escapeRegex).join('|')];
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 900_000, env: { ...process.env, CI: '1' } });
  let report;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { return { crashed: true, results: [], stderr: (result.stderr ?? '').slice(-600) }; }
  const results = report.testResults.flatMap((file) => file.assertionResults).filter((test) => test.status === 'passed' || test.status === 'failed')
    .map((test) => ({ name: test.fullName, status: test.status, message: (test.failureMessages ?? [])[0] ?? '' }));
  return { crashed: false, results };
}

const statusOf = (run, name) => run.results.filter((test) => test.name.includes(name));

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const headText = (file) => execFileSync('git', ['show', `${head}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// --check: every edit must match its file at HEAD exactly once, and every named test must exist at HEAD.
if (process.argv.includes('--check')) {
  let stale = 0;
  for (const mutation of MUTATIONS) {
    for (const edit of mutation.edits) {
      const count = headText(edit.file).split(edit.find).length - 1;
      if (count !== 1) { stale += 1; print(`${mutation.id}: ${edit.file} matches ${count} times`); }
    }
  }
  const tests = headText(FILE);
  for (const name of [RESTART, ABORT, ...SHARED_LEDGER_TESTS]) {
    const count = tests.split(name).length - 1;
    if (count !== 1) { stale += 1; print(`test name "${name}" matches ${count} times in ${FILE}`); }
  }
  print(`${MUTATIONS.length} mutations checked at ${head}: ${stale === 0 ? 'every edit and test name matches exactly once' : `${stale} stale`}`);
  process.exit(stale === 0 ? 0 : 1);
}

const dir = mkdtempSync(join(tmpdir(), 'gru-503-p1-mutations.'));
let exitCode = 0;
const rows = [];
try {
  execFileSync('sh', ['-c', `git archive ${head} | tar -x -C "${dir}"`], { cwd: root });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  execFileSync(process.execPath, ['tools/patch-vitest-rpc-timeout.mjs'], { cwd: dir, stdio: 'ignore' });
  print(`mutation record at ${head}`);

  const everyName = [RESTART, ABORT, ...SHARED_LEDGER_TESTS];
  const baseline = runNames(dir, everyName);
  const baselinePassed = everyName.every((name) => statusOf(baseline, name).length === 1 && statusOf(baseline, name)[0].status === 'passed');
  print(`baseline: ${baseline.results.filter((test) => test.status === 'passed').length} passed, ${baseline.results.filter((test) => test.status === 'failed').length} failed`);
  if (baseline.crashed || !baselinePassed) { exitCode = 1; print('  BASELINE FAILED', JSON.stringify(baseline.results.filter((test) => test.status === 'failed').map((test) => test.name)), baseline.stderr ?? ''); }

  for (const mutation of MUTATIONS) {
    if (only !== null && !only.has(mutation.id)) continue;
    const originals = new Map();
    let applied = true;
    for (const edit of mutation.edits) {
      const path = join(dir, edit.file);
      if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
      const text = readFileSync(path, 'utf8');
      const count = text.split(edit.find).length - 1;
      if (count !== 1) { applied = false; print(`${mutation.id}: edit does not match exactly once in ${edit.file} (${count})`); break; }
      writeFileSync(path, text.replace(edit.find, () => edit.replace));
    }
    let killed = [];
    let missed = [];
    let broken = [];
    let firstFailure = '';
    if (!applied) exitCode = 1;
    else {
      const run = runNames(dir, [...mutation.fails, ...mutation.holds]);
      killed = mutation.fails.filter((name) => { const found = statusOf(run, name); return found.length === 1 && found[0].status === 'failed'; });
      missed = mutation.fails.filter((name) => !killed.includes(name));
      broken = mutation.holds.filter((name) => { const found = statusOf(run, name); return !(found.length === 1 && found[0].status === 'passed'); });
      const failure = run.results.find((test) => test.status === 'failed' && mutation.fails.some((name) => test.name.includes(name)));
      firstFailure = failure === undefined ? '' : failure.message.split('\n').slice(0, 3).join(' | ').slice(0, 400);
      if (run.crashed || missed.length > 0 || broken.length > 0) exitCode = 1;
    }
    for (const [path, text] of originals) writeFileSync(path, text); // restore
    const restored = [...originals.keys()].every((path) => readFileSync(path, 'utf8') === headText(path.slice(dir.length + 1)));
    if (!restored) exitCode = 1;
    const verdict = !applied ? 'NOT APPLIED' : missed.length === 0 && broken.length === 0 ? 'killed' : 'SURVIVED';
    rows.push({ ...mutation, killed, missed, broken, verdict, restored, firstFailure });
    print(`${mutation.id}: ${verdict} [${killed.join(' ; ')}]${missed.length > 0 ? ` MISSED [${missed.join(' ; ')}]` : ''}${broken.length > 0 ? ` BROKE-EXISTING [${broken.join(' ; ')}]` : ''} restored=${restored ? 'byte-identical' : 'DIFFERS'} — ${mutation.what}`);
    if (firstFailure !== '') print(`    first failing assertion: ${firstFailure}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

print('\n| Mutation | Disabled | Must fail | Must still pass | Verdict | Restored |\n|---|---|---|---|---|---|');
for (const row of rows) print(`| ${row.id} | ${row.what} | ${row.fails.join('; ')} | ${row.holds.join('; ')} | ${row.verdict} | ${row.restored ? 'yes' : 'NO'} |`);
print(`\n${rows.filter((row) => row.verdict === 'killed').length}/${rows.length} mutations killed`);
process.exit(exitCode);
