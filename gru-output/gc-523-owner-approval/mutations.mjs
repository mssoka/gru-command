#!/usr/bin/env node
/**
 * #523 owner-approval mutation record.
 *
 * One mutation at a time is applied to its own `git archive HEAD` snapshot of
 * the candidate, and the tests that guard it are run by name. Every named test
 * must then FAIL BEHAVIORALLY (an assertion on what the owner or Gru would
 * observe), never by an import or collection error: the shared classifier
 * (`tools/assert-formal-verdicts-baseline.mjs`) refuses anything else. A test
 * that passes under its mutation has no teeth, and the claim is broken.
 *
 *   A1/A2  the native owner abandonment replaced by a no-op that returns the row
 *   F5     `workerGate` / `pendingProducerBlockers` no longer reach the abandonment
 *   F6     the stored failure message is no longer cut to 300 characters
 *   F7     a refusal's blockers no longer reach the card text
 *   F8     the liveness check runs before the idempotency-key replay
 *   F9     the idempotency key is no longer bounded to 128 characters
 *
 * Exit codes (all distinct on purpose):
 *   1  every mutation was caught (the expected, "RED" outcome of this scope)
 *   2  a claim is broken: a mutation passed, or a test failed for a non-behavioral reason
 *   3  a mutation anchor was not found exactly once, or the runner itself failed:
 *      a rotted anchor can never pass as red evidence
 *   0  only with --check, when every anchor matches exactly once at HEAD
 *
 * usage: node gru-output/gc-523-owner-approval/mutations.mjs [--check]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { assertNamedRedBaselineLeg } from '../../tools/assert-formal-verdicts-baseline.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SERVICE = 'src/dispatch/owner-approvals.ts';
const LEDGER = 'src/ledger/api.ts';
const TESTS = 'test/owner-approvals.test.ts';

const A = 'owner approval of abandonment';
const EVIDENCE = 'owner approval — the route evidence reaches the abandonment';
const CUT = 'owner approval — the stored failure message is redacted, then cut to 300 characters';
const FENCES = 'owner approval — the Approve is bound to the fences read when Gru asked';
const ANSWERS = 'owner approval — proposal answers and readback';

class AnchorError extends Error {}

/** Replace `from` by `to`; `from` must occur exactly once. */
const once = (from, to) => ({ from, to });

const NOOP_ANCHOR = '  /** Carry out the abandonment the record is bound to.';
const NOOP = [
  '  /** MUTATION (verification red baseline): a no-op instead of the native',
  "   * owner abandonment. It returns the request's current row unchanged. */",
  '  const mutatedNoop = (input: Parameters<typeof abandonLiveDirectiveFromRoute>[0]): ReturnType<typeof abandonLiveDirectiveFromRoute> => ({',
  '    record: input.ledger.getDirective(input.requestId) as never,',
  '    idempotent: false,',
  '    event: { seq: -1, payload: { reason: input.reason } } as never,',
  '  });',
  '',
  '',
].join('\n');

const REPLAY_FIRST = [
  '      const keyed = selectOwnerApprovalByKey(this.db, input.idempotencyKey);',
  "      if (keyed !== null) return { kind: keyed.bodyFingerprint === fingerprint ? 'replayed' : 'key_conflict', approval: keyed };",
  '      const row = this.getDirective(input.requestId);',
  "      if (row === null) return { kind: 'unknown_request' };",
  "      if (row.state !== 'dispatching' && row.state !== 'admitted') return { kind: 'not_live', state: directiveStateName(row) };",
  '',
].join('\n');
const LIVENESS_FIRST = [
  '      const row = this.getDirective(input.requestId);',
  "      if (row === null) return { kind: 'unknown_request' };",
  "      if (row.state !== 'dispatching' && row.state !== 'admitted') return { kind: 'not_live', state: directiveStateName(row) };",
  '      const keyed = selectOwnerApprovalByKey(this.db, input.idempotencyKey);',
  "      if (keyed !== null) return { kind: keyed.bodyFingerprint === fingerprint ? 'replayed' : 'key_conflict', approval: keyed };",
  '',
].join('\n');

const MUTATIONS = [
  {
    id: 'A1-A2 no-op abandonment',
    edits: [{ file: SERVICE, ...once('      outcome = abandonLiveDirectiveFromRoute({', '      outcome = mutatedNoop({') },
      { file: SERVICE, ...once(NOOP_ANCHOR, `${NOOP}${NOOP_ANCHOR}`) }],
    titles: [
      `${A} abandons an unknown-custody request as outcome-unknown and closes the card with what happened`,
      `${A} abandons a live request on a merged job whose lane is gone: the job stays merged and nothing is replayed`,
    ],
  },
  {
    id: 'F5 workerGate dropped from execute()',
    edits: [{ file: SERVICE, ...once('        ...(deps.workerGate !== undefined ? { workerGate: deps.workerGate } : {}),\n', '') }],
    titles: [`${EVIDENCE} refuses live_work while a pace-gate worker turn is queued for the job, on the record and on the card`],
  },
  {
    id: 'F5 pendingProducerBlockers dropped from execute()',
    edits: [{ file: SERVICE, ...once('        pendingProducerBlockers: deps.pendingProducerBlockers,\n', '        pendingProducerBlockers: () => [],\n') }],
    titles: [`${EVIDENCE} refuses live_work for a producer the supervisor still reports, on the record and on the card`],
  },
  {
    id: 'F6 failure message no longer cut to 300',
    edits: [{ file: SERVICE, ...once('.slice(0, ERROR_MESSAGE_CHARS)', '') }],
    titles: [
      `${CUT} drops a credential that begins after position 300 along with the rest of the cut`,
      `${CUT} leaves no fragment of a credential that straddles position 300`,
    ],
  },
  {
    id: 'F7 refusal blockers dropped from the card text',
    edits: [{ file: SERVICE, ...once('    ...refusal.blockers,\n', '') }],
    titles: [
      `${FENCES} refuses a changed state`,
      `${FENCES} refuses live_work when a producer appears after the proposal, and reconcile never asks twice`,
      `${FENCES} refuses every decider that is not exactly owner, with Approve and with Deny`,
    ],
  },
  {
    id: 'F8 liveness check above the key replay',
    edits: [{ file: LEDGER, ...once(REPLAY_FIRST, LIVENESS_FIRST) }],
    titles: [`${ANSWERS} answers a replay of the original key and body with 200 after the request has ended, before any not-live check`],
  },
  {
    id: 'F9 idempotency key unbounded',
    edits: [{ file: SERVICE, ...once('{1,128}', '{1,}') }],
    titles: [`${ANSWERS} accepts a 128-character idempotency key and refuses a 129-character one`],
  },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function extractHead(dir) {
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
}

function applyEdits(dir, mutation) {
  for (const { file, from, to } of mutation.edits) {
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    const count = source.split(from).length - 1;
    if (count !== 1) {
      throw new AnchorError(`mutation "${mutation.id}": anchor in ${file} matches ${String(count)} time(s), expected exactly 1:\n${from}`);
    }
    writeFileSync(path, source.replace(from, () => to), 'utf8');
  }
}

function check() {
  const dir = mkdtempSync(join(tmpdir(), 'gru-523-mutations-check.'));
  try {
    extractHead(dir);
    for (const mutation of MUTATIONS) applyEdits(dir, mutation);
    process.stdout.write(`gc-523 mutations --check: ${String(MUTATIONS.length)} mutation(s), every anchor matches exactly once at HEAD\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run() {
  const passLines = [];
  for (const mutation of MUTATIONS) {
    const dir = mkdtempSync(join(tmpdir(), 'gru-523-mutation.'));
    try {
      extractHead(dir);
      applyEdits(dir, mutation);
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
      const patch = spawnSync('node', ['tools/patch-vitest-rpc-timeout.mjs'], { cwd: dir, stdio: 'inherit' });
      if (patch.status !== 0) throw new Error('vitest rpc timeout patch failed');
      const results = join(dir, 'results.json');
      const pattern = mutation.titles.map(escapeRegExp).join('|');
      const vitest = spawnSync('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${results}`, TESTS, '-t', pattern], {
        cwd: dir, stdio: ['ignore', 'ignore', 'inherit'],
      });
      process.stdout.write(`[${mutation.id}] vitest exit=${String(vitest.status)} (EXPECTED-NONZERO)\n`);
      if (vitest.status === 0) {
        process.stdout.write(`FAILS-BEFORE CLAIM BROKEN: the mutation "${mutation.id}" passed its tests\n`);
        return 2;
      }
      try {
        passLines.push(assertNamedRedBaselineLeg(mutation.id, JSON.parse(readFileSync(results, 'utf8')), mutation.titles));
      } catch (error) {
        process.stdout.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
        return 2;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const line of passLines) process.stdout.write(`${line}\n`);
  process.stdout.write(`EXPECTED-NONZERO: every one of ${String(MUTATIONS.length)} mutations is caught behaviorally\n`);
  return 1;
}

try {
  if (process.argv.includes('--check')) {
    check();
    process.exitCode = 0;
  } else {
    process.exitCode = run();
  }
} catch (error) {
  process.stderr.write(`${error instanceof AnchorError ? 'MUTATION ANCHOR MISSING' : 'MUTATION RUNNER FAILED'}: ${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 3;
}
