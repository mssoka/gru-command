#!/usr/bin/env node
// Mutation record for the canceled-request closeout suite (#523).
//
// For each mutation this extracts the committed HEAD into a scratch directory
// (node_modules linked), disables ONE guard, step or call, runs the tests that
// cover it, and requires every named test to fail. It then restores the file
// and the suite must pass again. Nothing in the working tree is touched.
//
//   node gru-output/gc-523-closeout/mutations.mjs [--only M01,M07]
//
// Exit 0 only when the unmutated baseline passes and every mutation is killed
// by the tests it names. Run through the `closeout-523-mutations`
// verify scope (the lane's declared scheduler entry).
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const print = (text) => process.stdout.write(`${text}\n`);

const root = process.cwd();
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;

const NEW = { heavy: true, files: ['test/canceled-request-closeout.test.ts'], name: 'closeout suite' };
const SEAM = { heavy: false, files: ['test/silas-deterministic-seam.test.ts'], name: 'deterministic seam' };
const BOARD = { heavy: false, files: ['test/board-server.test.ts'], name: 'board server', only: [' #523 '] };
const READBACK = { heavy: false, files: ['test/directive-retirement.test.ts'], name: 'readback', only: [' GET /api/silas/directives/{id} names the closeout path'] };

const PROGRESS = 'src/dispatch/directive-progress.ts';
const API = 'src/ledger/api.ts';
const CLOSEOUTS = 'src/ledger/closeouts.ts';
const EXEC = 'src/dispatch/canceled-request-closeout.ts';
const RECOVERY = 'src/dispatch/directive-recovery.ts';

/** id, the numbered test it covers, what is disabled, the edits, the run, the tests that must fail. */
const MUTATIONS = [
  { id: 'M01', test: 1, what: 'S3 does not resolve the request card', run: NEW, fails: ['1a', '1b'],
    edits: [{ file: API, find: "if (card?.routing === 'action-required') this.resolveNotificationById(card.id, CLOSEOUT_ACTOR);", replace: '' }] },
  { id: 'M02', test: 1, what: 'S2 (the retirement) is skipped', run: NEW, fails: ['1a', '1b'],
    edits: [{ file: EXEC, find: 'if (!guard.retired) {', replace: 'if (false) {' }] },
  { id: 'M03', test: 2, what: 'a parked job is read as a cancel by resumePending', run: NEW, fails: ['2'],
    edits: [{ file: EXEC, find: 'const counts = { examined: 0, completed: 0, stopped: 0, superseded: 0, untouched: 0 };',
      replace: "const counts = { examined: 0, completed: 0, stopped: 0, superseded: 0, untouched: 0 };\n    for (const job of this.deps.ledger.listJobs()) if (job.status === 'parked') this.requestBinning(job.id, { status: 'binned' });" }] },
  { id: 'M04', test: 3, what: 'S2 is re-run although the request is already retired', run: NEW, fails: ['3b'],
    edits: [{ file: EXEC, find: 'if (!guard.retired) {', replace: 'if (true) {' }] },
  { id: 'M05', test: 3, what: 'resumePending resumes nothing', run: NEW, fails: ['3a', '3b', '3d'],
    edits: [{ file: EXEC, find: 'for (const closeoutId of this.deps.ledger.listActiveCloseoutIds()) {', replace: 'for (const closeoutId of [] as string[]) {' }] },
  { id: 'M06', test: 4, what: 'no redispatch fence (claimDirectiveDispatch and assertDirectiveAuthority)', run: NEW, fails: ['4a', '4b'],
    edits: [{ file: API, find: '    return this.transaction(() => {\n      this.assertNoPendingCloseout(requestId);\n      const identity = this.directiveTurnIdentity(requestId);', replace: '    return this.transaction(() => {\n      const identity = this.directiveTurnIdentity(requestId);' },
      { file: API, find: '    validateDirectiveIdentity(identity);\n    this.assertNoPendingCloseout(identity.requestId);', replace: '    validateDirectiveIdentity(identity);' }] },
  { id: 'M07', test: 4, what: 'assertDirectiveAuthority does not know the fence', run: NEW, fails: ['4a'],
    edits: [{ file: API, find: '    validateDirectiveIdentity(identity);\n    this.assertNoPendingCloseout(identity.requestId);', replace: '    validateDirectiveIdentity(identity);' }] },
  { id: 'M08', test: 4, what: 'reconsider does not skip a request a closeout owes its end', run: NEW, fails: ['4a', '4b'],
    edits: [{ file: PROGRESS, find: 'if (this.deps.ledger.hasPendingCloseout(row.requestId)) continue;', replace: '' }] },
  { id: 'M09', test: 4, what: 'surfaceDirectiveRecovery posts a card for a closeout-owned request', run: NEW, fails: ['4c'],
    edits: [{ file: PROGRESS, find: 'if (deps.ledger.hasPendingCloseout(requestId)) return;', replace: '' }] },
  { id: 'M10', test: 5, what: 'an S2 guard refusal is not caught (the intent is never stopped)', run: NEW, fails: ['5a'],
    edits: [{ file: EXEC, find: "by: CLOSEOUT_ACTOR,\n      });\n      return null;\n    } catch (error) {\n      if (error instanceof DirectiveRetirementError) return blockersOf(error);",
      replace: "by: CLOSEOUT_ACTOR,\n      });\n      return null;\n    } catch (error) {\n      if (false) return blockersOf(error as DirectiveRetirementError);" }] },
  { id: 'M11', test: 5, what: 'the S3 live-work refusal is not caught', run: NEW, fails: ['5b'],
    edits: [{ file: EXEC, find: 'if (!(error instanceof TerminalLiveWorkError)) throw error;', replace: 'throw error;' }] },
  { id: 'M12', test: 5, what: 'a stopped intent with an unchanged fingerprint is re-driven and re-recorded', run: NEW, fails: ['5a', '5b'],
    edits: [{ file: EXEC, find: "if (closeoutBlockerFingerprint(this.currentBlockers(intent)) === intent.blockerFingerprint) return null;", replace: '' },
      { file: API, find: "if (intent.state === 'stopped' && intent.blockerFingerprint === closeoutBlockerFingerprint(blockers)) return intent;", replace: '' }] },
  { id: 'M13', test: 5, what: 'a stopped intent never resumes, whatever changed', run: NEW, fails: ['5a', '5b', '5c'],
    edits: [{ file: EXEC, find: "if (closeoutBlockerFingerprint(this.currentBlockers(intent)) === intent.blockerFingerprint) return null;", replace: 'return null;' }] },
  { id: 'M14', test: 5, what: 'the blocker fingerprint ignores the blocker details', run: NEW, fails: ['5c'],
    edits: [{ file: CLOSEOUTS, find: 'blockers.map(({ code, detail }) => [code, detail] as const)', replace: "blockers.map(({ code }) => [code, ''] as const)" }] },
  { id: 'M15', test: 6, what: 'a completed closeout is not answered again', run: NEW, fails: ['6'],
    edits: [{ file: EXEC, find: "if (latest !== null && latest.state === 'complete') return completeBody(job, latest);", replace: '' }] },
  { id: 'M16', test: 7, what: 'P1: the job status is not revalidated', run: NEW, fails: ['7a'],
    edits: [{ file: API, find: "if (job === null || job.status !== intent.jobStatus) return { reason: 'job-status', retired };", replace: "if (job === null) return { reason: 'job-status', retired };" }] },
  { id: 'M17', test: 7, what: 'a superseded intent still fences the request', run: NEW, fails: ['7a'],
    edits: [{ file: CLOSEOUTS, find: "\"SELECT * FROM request_closeouts WHERE request_id = ? AND state IN ('open', 'stopped')\"", replace: "\"SELECT * FROM request_closeouts WHERE request_id = ? AND state IN ('open', 'stopped', 'superseded')\"" }] },
  { id: 'M18', test: 7, what: 'P3: later work on the job is not revalidated', run: NEW, fails: ['7b'],
    edits: [{ file: API, find: "if (later !== undefined) return { reason: 'later-work', retired };", replace: '' }] },
  { id: 'M19', test: 7, what: 'P4: control events after the intent are not revalidated', run: NEW, fails: ['7c'],
    edits: [{ file: API, find: "if (control.length > own.length || own.length > 1) return { reason: 'control-event', retired };", replace: '' }] },
  { id: 'M20', test: 7, what: 'S3 does not revalidate (completeCloseout)', run: NEW, fails: ['7b', '7c'],
    edits: [{ file: API, find: "const stale = this.closeoutStaleReason(intent, 'bin');\n      if (stale.reason !== null) return { kind: 'superseded' as const, intent: this.supersedeCloseout(intent, stale.reason) };", replace: '' }] },
  { id: 'M21', test: 7, what: 'a request retired by hand after the intent does not satisfy S2', run: NEW, fails: ['7d'],
    edits: [{ file: API, find: "const retired = row !== null && row.state === 'retired' && row.abandonedAt === null && retireEvent !== null;", replace: 'const retired = false;' }] },
  { id: 'M22', test: 8, what: 'the supervisor producer check is dropped', run: NEW, fails: ['8a'],
    edits: [{ file: RECOVERY, find: 'if (producerBlockers.length > 0) {\n    throw new DirectiveRetirementError(\'live_work\', `job "${jobId}" has pending supervised producer ownership`', replace: 'if (false) {\n    throw new DirectiveRetirementError(\'live_work\', `job "${jobId}" has pending supervised producer ownership`' }] },
  { id: 'M23', test: 8, what: 'the pace-gate queue check is dropped', run: NEW, fails: ['8b'],
    edits: [{ file: RECOVERY, find: '.find((entry) => entry.id === jobId || agentIds.has(entry.id));\n    if (queued !== undefined) {\n      throw new DirectiveRetirementError(\n        \'live_work\',\n        `job "${jobId}" has a queued worker turn', replace: '.find(() => false);\n    if (queued !== undefined) {\n      throw new DirectiveRetirementError(\n        \'live_work\',\n        `job "${jobId}" has a queued worker turn' }] },
  { id: 'M24', test: 8, what: 'the ledger ownership blockers (admission, open turn, round, verification) are dropped from the preflight', run: NEW, fails: ['8c', '8d', '8e', '8f'],
    edits: [{ file: API, find: 'const blockers = this.directiveRetirementBlockers(row, laneId);', replace: 'const blockers: readonly string[] = [];' }] },
  { id: 'M25', test: 8, what: 'the correlated terminal receipt check is dropped from the preflight', run: NEW, fails: ['8g'],
    edits: [{ file: API, find: "const delivered = this.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);\n      if (delivered !== null) {\n        throw new DirectiveRetirementError(\n          'terminal_receipt_present',\n          `directive request \"${requestId}\"", replace: "const delivered = null as { seq: number } | null;\n      if (delivered !== null) {\n        throw new DirectiveRetirementError(\n          'terminal_receipt_present',\n          `directive request \"${requestId}\"" }] },
  { id: 'M26', test: 8, what: 'a legacy request (null request_kind) is eligible', run: NEW, fails: ['8h'],
    edits: [{ file: API, find: "request.state !== 'dispatching' || request.requestKind === null || request.dispatchStartedAt", replace: "request.state !== 'dispatching' || request.dispatchStartedAt" },
      { file: API, find: "      if (error instanceof DirectiveCheckpointError) return null;\n      throw error;\n    }\n    return request;", replace: '      throw error;\n    }\n    return request;' }] },
  { id: 'M27', test: 8, what: 'a claimed request that was never deferred is eligible', run: NEW, fails: ['8k'],
    edits: [{ file: API, find: 'try { if (!this.hasDirectiveDispatchDeferral(request.requestId)) return null; }', replace: 'try { if (false) return null; }' }] },
  { id: 'M28', test: 8, what: 'an admitted request is eligible', run: NEW, fails: ['8l'],
    edits: [{ file: API, find: "request.state !== 'dispatching' || request.requestKind === null", replace: 'request.requestKind === null' },
      { file: API, find: 'try { if (!this.hasDirectiveDispatchDeferral(request.requestId)) return null; }', replace: 'try { if (false) return null; }' }] },
  { id: 'M29', test: 8, what: 'a pending re-brief marker is ignored by the eligibility rule', run: NEW, fails: ['8o'],
    edits: [{ file: API, find: 'if (live.length !== 1 || this.listPendingRebriefs({ jobId }).length > 0) return null;', replace: 'if (live.length !== 1) return null;' }] },
  { id: 'M30', test: 8, what: 'the 500-character reason limit is not enforced', run: NEW, fails: ['8n'],
    edits: [{ file: EXEC, find: "typeof rawReason === 'string' && Array.from(rawReason).length > CLOSEOUT_REASON_MAX_CHARS", replace: 'false' }] },
  { id: 'M31', test: 8, what: 'S1 does not evaluate again inside its transaction', run: NEW, fails: ['8p'],
    edits: [{ file: API, find: 'const blockers = input.evaluate();\n      if (blockers.length > 0) return { kind: \'refused\' as const, blockers };', replace: '' }] },
  { id: 'M31b', test: 8, what: 'the executor evaluates nothing: no guard refuses a binning request', run: NEW, fails: ['8a', '8b', '8c', '8d', '8e', '8f', '8g', '8p'],
    edits: [{ file: EXEC, find: "blockers: this.retirementBlockers(request) };\n  }", replace: 'blockers: [] };\n  }' }] },
  { id: 'M32', test: 9, what: 'every request is stored as gru', run: NEW, fails: ['9a', '9c'],
    edits: [{ file: CLOSEOUTS, find: "return by === 'gru' ? 'gru' : 'unattributed';", replace: "return 'gru';" }] },
  { id: 'M33', test: 9, what: 'the stored reason is not appended to the retire reason', run: NEW, fails: ['9d'],
    edits: [{ file: EXEC, find: 'reason: intent.reason === null ? base : `${base}: ${intent.reason}`,', replace: 'reason: base,' }] },
  { id: 'M34', test: 9, what: 'the retirement is attributed to the owner', run: NEW, fails: ['1a', '1b', '9a', '9d'],
    edits: [{ file: EXEC, find: 'reason: intent.reason === null ? base : `${base}: ${intent.reason}`,\n        by: CLOSEOUT_ACTOR,', replace: "reason: intent.reason === null ? base : `${base}: ${intent.reason}`,\n        by: 'owner'," }] },
  { id: 'M35', test: 10, what: 'the readback calls a blocked closeout eligible', run: NEW, fails: ['10', '10b'],
    edits: [{ file: EXEC, find: "eligible: evaluation.blockers.length === 0, blockers: evaluation.blockers, intent };", replace: 'eligible: true, blockers: evaluation.blockers, intent };' }] },
  { id: 'M36', test: 11, what: 'boot recovery resumes before it reconsiders', run: NEW, fails: ['11a'],
    edits: [{ file: EXEC, find: '  deps.directiveProgress.reconsider();\n  return deps.closeout.resumePending();', replace: '  const report = deps.closeout.resumePending();\n  deps.directiveProgress.reconsider();\n  return report;' }] },
  { id: 'M37', test: 11, what: 'binningCloseoutRoute never reaches the closeout', run: NEW, fails: ['11b'],
    edits: [{ file: EXEC, find: 'return (jobId, body) => getCloseout()?.requestBinning(jobId, body) ?? null;', replace: 'return () => null;' }] },
  { id: 'M38', test: 11, what: 'the deterministic pass does not resume closeouts', run: SEAM, fails: ['P35'],
    edits: [{ file: 'src/dispatch/durable-reconcile.ts', find: ' deps.closeout?.resumePending(); }', replace: ' }' }] },
  { id: 'M39', test: 12, what: 'the board status route ignores the binningCloseout option', run: BOARD, fails: ['#523'],
    edits: [{ file: 'src/board/server.ts', find: 'const closeout = options.binningCloseout?.(id, body) ?? null;', replace: 'const closeout = null;' }] },
  { id: 'M40', test: 12, what: 'the directive readback omits the closeout member', run: READBACK, fails: ['GET /api/silas/directives/{id} names the closeout path'],
    edits: [{ file: 'src/dispatch/server.ts', find: '...(options.closeout === undefined ? {} : { closeout: closeoutReadback(options.closeout, requestId) }),', replace: '' }] },
  { id: 'M41', test: 8, what: 'a request that already carries a recovery decision is eligible', run: NEW, fails: ['8q', '10'],
    edits: [{ file: API, find: ' || request.recoveryDecision !== null) return null;', replace: ') return null;' }] },
  { id: 'M42', test: 7, what: 'P2: a change to the request itself is not revalidated before S2', run: NEW, fails: ['7e'],
    edits: [{ file: API, find: "if (!pending && !retired) return { reason: 'request-state', retired };", replace: '' }] },
  { id: 'M43', test: 5, what: 'a stopped intent whose basis changed is never superseded', run: NEW, fails: ['7f', '7g'],
    edits: [{ file: EXEC, find: "if (stale !== null) return { kind: 'superseded', intent: stale };", replace: '' }] },
  { id: 'M44', test: 5, what: 'a binned retry after another writer binned the job answers 409 instead of the plain 200', run: NEW, fails: ['7g'],
    edits: [{ file: EXEC, find: "if (resumed.kind === 'superseded' && ledger.getJob(jobId)?.status === 'binned') return null;", replace: '' }] },
  { id: 'M45', test: 5, what: 'the blocker fingerprint depends on blocker order', run: NEW, fails: ['5d'],
    edits: [{ file: CLOSEOUTS, find: '.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));', replace: ';' }] },
  { id: 'M46', test: 3, what: 'the resume loop reads every pending row outside its per-intent guard', run: NEW, fails: ['3e'],
    edits: [{ file: EXEC, find: 'for (const closeoutId of this.deps.ledger.listActiveCloseoutIds()) {', replace: 'for (const closeoutId of this.deps.ledger.listActiveCloseoutIds().filter((id) => this.deps.ledger.getCloseout(id) !== null)) {' }] },
  { id: 'M47', test: 10, what: 'the readback ignores an open or stopped intent (reads binning after S2)', run: NEW, fails: ['10d'],
    edits: [{ file: EXEC, find: "if (active !== null) return { path: 'closeout', request: ledger.getDirective(active.requestId), blockers: this.currentBlockers(active) };", replace: '' }] },
  { id: 'M48', test: 10, what: 'the readback calls every request of an eligible job the closeout path', run: NEW, fails: ['10c'],
    edits: [{ file: EXEC, find: 'if (evaluation === null || evaluation.request?.requestId !== requestId)', replace: 'if (evaluation === null || evaluation.request === null)' }] },
  { id: 'M49', test: 8, what: 'a non-string reason is accepted by the closeout path', run: NEW, fails: ['8n'],
    edits: [{ file: EXEC, find: "if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') return invalidReason;", replace: '' }] },
  { id: 'M50', test: 7, what: 'a supersession writes no silas.closeout-superseded event', run: NEW, fails: ['7a', '7b'],
    edits: [{ file: API, find: "kind: 'silas.closeout-superseded'", replace: "kind: 'silas.closeout-supersededx'" }] },
  { id: 'M51', test: 5, what: 'the stopped event does not carry the blocker fingerprint', run: NEW, fails: ['5a'],
    edits: [{ file: API, find: 'blocker_fingerprint: stopped.blockerFingerprint, by: CLOSEOUT_ACTOR', replace: 'by: CLOSEOUT_ACTOR' }] },
  { id: 'M52', test: 1, what: 'the closeout records a dispatch after completing', run: NEW, fails: ['1a', '1b'],
    edits: [{ file: EXEC, find: "if (completed.kind === 'superseded') return { kind: 'superseded', intent: completed.intent };",
      replace: "if (completed.kind === 'superseded') return { kind: 'superseded', intent: completed.intent };\n    ledger.appendCustomEvent({ kind: 'silas.directive-dispatch-started', jobId: completed.intent.jobId, payload: { request_id: completed.intent.requestId } });" }] },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Run one test spec in the scratch tree; returns the failed full names and the run status. */
function runSpec(dir, spec, failsOnly) {
  const out = join(dir, `.mutation-${Math.random().toString(36).slice(2)}.json`);
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...(spec.heavy ? ['--config', 'vitest.heavy.config.ts'] : []),
    '--reporter=json', '--outputFile', out, ...spec.files];
  if (failsOnly !== undefined) args.push('-t', failsOnly);
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 900_000, env: { ...process.env, CI: '1' } });
  let report;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { return { failed: [], passed: 0, status: result.status, crashed: true, stderr: (result.stderr ?? '').slice(-600) }; }
  const all = report.testResults.flatMap((file) => file.assertionResults);
  return { failed: all.filter((t) => t.status === 'failed').map((t) => t.fullName), passed: all.filter((t) => t.status === 'passed').length, status: result.status, crashed: false };
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

// --check: every edit must match its file at HEAD exactly once; nothing is run.
if (process.argv.includes('--check')) {
  let stale = 0;
  for (const mutation of MUTATIONS) {
    for (const edit of mutation.edits) {
      const text = execFileSync('git', ['show', `${head}:${edit.file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const count = text.split(edit.find).length - 1;
      if (count !== 1) { stale += 1; print(`${mutation.id}: ${edit.file} matches ${count} times`); }
    }
  }
  print(`${MUTATIONS.length} mutations checked at ${head}: ${stale === 0 ? 'every edit matches exactly once' : `${stale} stale`}`);
  process.exit(stale === 0 ? 0 : 1);
}
const dir = mkdtempSync(join(tmpdir(), 'gru-523-mutations.'));
let exitCode = 0;
const rows = [];
try {
  execFileSync('sh', ['-c', `git archive ${head} | tar -x -C "${dir}"`], { cwd: root });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  execFileSync(process.execPath, ['tools/patch-vitest-rpc-timeout.mjs'], { cwd: dir, stdio: 'ignore' });
  print(`mutation record at ${head}`);

  const baselines = new Map();
  const baseline = (spec) => {
    if (!baselines.has(spec)) {
      const started = Date.now();
      const filter = spec.only === undefined ? undefined : spec.only.map(escapeRegex).join('|');
      const result = runSpec(dir, spec, filter);
      baselines.set(spec, result);
      print(`baseline ${spec.name}: ${result.passed} passed, ${result.failed.length} failed (${Date.now() - started} ms)`);
      if (result.crashed || result.failed.length > 0 || result.passed === 0) { exitCode = 1; print('  BASELINE FAILED', result.failed.slice(0, 5), result.stderr ?? ''); }
    }
    return baselines.get(spec);
  };

  for (const mutation of MUTATIONS) {
    if (only !== null && !only.has(mutation.id)) continue;
    baseline(mutation.run);
    const originals = new Map();
    let applied = true;
    for (const edit of mutation.edits) {
      const path = join(dir, edit.file);
      const text = originals.has(path) ? readFileSync(path, 'utf8') : (originals.set(path, readFileSync(path, 'utf8')), originals.get(path));
      const count = text.split(edit.find).length - 1;
      if (count !== 1) { applied = false; print(`${mutation.id}: edit does not match exactly once in ${edit.file} (${count})`); break; }
      writeFileSync(path, text.replace(edit.find, () => edit.replace));
    }
    let killed = [];
    let missed = [];
    let detail = '';
    if (!applied) { exitCode = 1; detail = 'edit did not apply'; } else {
      const tests = mutation.fails.map((id) => escapeRegex(id));
      const filter = mutation.run === SEAM ? 'P35' : mutation.run.only !== undefined ? mutation.run.only.map(escapeRegex).join('|')
        : ` (${tests.join('|')})\\. `;
      const result = runSpec(dir, mutation.run, filter);
      const failedNames = result.failed;
      killed = mutation.fails.filter((id) => failedNames.some((name) => mutation.run === NEW ? new RegExp(` ${escapeRegex(id)}\\. `).test(name) : name.includes(id)));
      missed = mutation.fails.filter((id) => !killed.includes(id));
      if (result.crashed) detail = `run crashed: ${result.stderr}`;
      if (missed.length > 0 || result.crashed) exitCode = 1;
    }
    for (const [path, text] of originals) writeFileSync(path, text); // restore
    // Restored: the covering tests pass again.
    let restored = 'n/a';
    if (applied) {
      const filter = mutation.run === SEAM ? 'P35' : mutation.run.only !== undefined ? mutation.run.only.map(escapeRegex).join('|')
        : ` (${mutation.fails.map((id) => escapeRegex(id)).join('|')})\\. `;
      const again = runSpec(dir, mutation.run, filter);
      restored = again.failed.length === 0 && again.passed > 0 ? 'pass' : 'FAIL';
      if (restored !== 'pass') exitCode = 1;
    }
    const verdict = !applied ? 'NOT APPLIED' : missed.length === 0 ? 'killed' : 'SURVIVED';
    rows.push({ ...mutation, killed, missed, verdict, restored, detail });
    print(`${mutation.id} test ${mutation.test}: ${verdict} [${killed.join(',')}]${missed.length > 0 ? ` MISSED [${missed.join(',')}]` : ''} restored=${restored} — ${mutation.what}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

print('\n| Mutation | Test | Disabled | Run | Failing tests (mutated) | Restored |\n|---|---|---|---|---|---|');
for (const row of rows) print(`| ${row.id} | ${row.test} | ${row.what} | ${row.run.name} | ${row.verdict === 'killed' ? row.killed.join(', ') : row.verdict} | ${row.restored} |`);
print(`\n${rows.filter((row) => row.verdict === 'killed').length}/${rows.length} mutations killed`);
process.exit(exitCode);
