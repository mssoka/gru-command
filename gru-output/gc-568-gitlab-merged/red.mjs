#!/usr/bin/env node
/**
 * gc-568-red: the fail-before leg of #568's GitLab merge mapping.
 *
 * The deliverable is a NEW poll module, so "archive the base and run the final
 * test" can only produce an import failure there — which proves nothing. This
 * leg instead mutates the ONE decision A1 claims: with the merge mapping
 * removed (observe, never merge) the lane must stay `in-review` and A1 must
 * RED by assertion. It is a mutation red: it runs against a fresh `git archive`
 * of HEAD, so nothing works in place and the working tree is never touched.
 *
 * Exit codes: 0 is never success here — the leg exits 1 once the classifier
 * has accepted the RED (the established expected-nonzero shape), and 2 when
 * the claim is broken (the mutation anchor is missing, A1 passes, or the
 * failure is an import/setup failure rather than a behavioral assertion).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const LABEL = 'gc-568';
const TARGET = 'src/dispatch/gitlab-poll.ts';
const ANCHOR = "      if (facts === null || facts.state !== 'merged' || !sameIdentity(lane.link, facts)) continue;";
const MUTATION = '      if (facts !== null) continue; // MUTATION: observe every answer, merge none';
/** The A1 case exactly as Vitest reports it (`<describe> <case>`). */
const A1 = 'gitlab signal poll tick A1: a merged MR closes each live lane status through the legal in-review hop, once';

const root = process.cwd();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dir = mkdtempSync(join(tmpdir(), 'gru-gc568-red-'));
const archive = spawnSync('sh', ['-c', `git archive ${head} | tar -x -C ${dir}`], { cwd: root, stdio: 'inherit' });
if (archive.status !== 0) {
  process.stderr.write(`${LABEL}: git archive ${head} failed\n`);
  process.exit(2);
}

const file = join(dir, TARGET);
const source = readFileSync(file, 'utf8');
if (!source.includes(ANCHOR)) {
  process.stderr.write(`${LABEL}: MUTATION ANCHOR MISSING in ${TARGET} at ${head}\n`);
  process.exit(2);
}
writeFileSync(file, source.replace(ANCHOR, MUTATION));

symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
const prep = join(root, '_bmad-output', 'gate-prep');
mkdirSync(prep, { recursive: true });
writeFileSync(join(prep, 'gc-568-red.last-snapshot.txt'), `${LABEL}-red head=${head} dir=${dir}\nmutation=${MUTATION.trim()}\n`);

const patch = spawnSync(process.execPath, [join(root, 'tools', 'patch-vitest-rpc-timeout.mjs')], {
  cwd: dir,
  stdio: 'inherit',
});
if (patch.status !== 0) {
  process.stderr.write(`${LABEL}: PATCH TOOL FAILED at the mutation snapshot\n`);
  process.exit(2);
}

const results = join(dir, 'results.json');
const vitest = spawnSync(
  'npx',
  ['vitest', 'run', '--reporter=json', `--outputFile=${results}`, 'test/gitlab-poll.test.ts', '-t', A1],
  { cwd: dir, stdio: 'inherit' },
);
process.stdout.write(`${LABEL}-red vitest exit=${String(vitest.status)} EXPECTED-NONZERO: the mutation records observations and never merges\n`);
if (vitest.status === 0) {
  process.stderr.write(`${LABEL}: FAILS-BEFORE CLAIM BROKEN — A1 passed with the merge mapping removed\n`);
  process.exit(2);
}

const classify = spawnSync(
  process.execPath,
  [join(root, 'tools', 'assert-named-red-baseline.mjs'), LABEL, results, A1],
  { stdio: 'inherit' },
);
if (classify.status !== 0) process.exit(2);

process.stdout.write(`${LABEL}: EXPECTED-NONZERO — A1 REDs by assertion once the merge mapping is removed\n`);
process.exit(1);
