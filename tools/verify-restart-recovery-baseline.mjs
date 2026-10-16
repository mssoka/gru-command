import process from 'node:process';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import ts from 'typescript';
import { assertRestartRecoveryBaseline, BaselineRecoveryGateError } from './assert-restart-recovery-baseline.mjs';

const BASELINE = '32fc2f6edfc878b89d05c4d2499dcbdb0ec662d1';
const TEST_FILE = 'test/pi-adapter.test.ts';
const TEST_NAME = 'restart recovery records actual admission while the native prompt remains pending';
const root = process.cwd();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function requireEvidence(condition, message) {
  if (!condition) throw new BaselineRecoveryGateError(message);
}
function parse(source) {
  const file = ts.createSourceFile(TEST_FILE, source, ts.ScriptTarget.Latest, true);
  requireEvidence(file.parseDiagnostics.length === 0, 'test source has parse errors; not behavioral RED');
  return file;
}
function namedTests(file) {
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === TEST_NAME) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return matches;
}
function admissionAssertionLine(file, test) {
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toHaveLength' &&
        ts.isCallExpression(node.expression.expression) && ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === 'expect' &&
        node.expression.expression.arguments[0] !== undefined && ts.isIdentifier(node.expression.expression.arguments[0]) && node.expression.expression.arguments[0].text === 'admissions' &&
        node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0]) && node.arguments[0].text === '1') matches.push(node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new BaselineRecoveryGateError('selected regression imports a module; baseline must use existing helpers only');
    ts.forEachChild(node, visit);
  }
  visit(test);
  requireEvidence(matches.length === 1, 'selected regression must have one exact admission-length assertion');
  return file.getLineAndCharacterOfPosition(matches[0].getStart(file)).line + 1;
}
/** Run a child, teeing its complete output into `log`. A capture write that
 * fails (ENOSPC, EIO) is no evidence: the child is stopped, its streams are
 * released, and the run rejects once it has closed — never an escaped throw
 * that skips the attempt's refusal manifest (#363 S09-0-02). */
export function run(command, args, cwd, log, sinks = [process.stdout, process.stderr]) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let captureFailure = null;
    for (const [stream, sink] of [[child.stdout, sinks[0]], [child.stderr, sinks[1]]]) {
      stream.on('data', (bytes) => {
        if (captureFailure !== null) return;
        try { appendFileSync(log, bytes); } catch (error) {
          captureFailure = error;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          child.stdout.destroy();
          child.stderr.destroy();
          return;
        }
        sink.write(bytes);
      });
    }
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (captureFailure !== null) reject(new BaselineRecoveryGateError(`complete output capture failed (${String(captureFailure)}); the child was stopped — not behavioral RED`));
      else resolveRun({ exitCode, signal });
    });
  });
}

async function main() {
let attempt;
let manifest = { version: 1, baselineSourceSha: BASELINE, testFile: TEST_FILE, testName: TEST_NAME, classification: 'unproven', startedAt: new Date().toISOString() };
function save() {
  if (attempt !== undefined) writeFileSync(join(attempt, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
try {
  const head = git('rev-parse', 'HEAD').trim();
  const artifactRoot = resolve(root, '_bmad-output', 'verification', 'gh-286-baseline', head);
  mkdirSync(artifactRoot, { recursive: true });
  attempt = mkdtempSync(join(artifactRoot, `attempt-${randomUUID()}-`));
  manifest = { ...manifest, driverHead: head, finalTestHead: head, attempt };
  save();
  requireEvidence(git('status', '--porcelain', '--untracked-files=normal').trim() === '', 'final committed source must be clean; not behavioral RED');
  requireEvidence(git('rev-parse', `${BASELINE}^{commit}`).trim() === BASELINE, 'baseline commit is unavailable; no fetch or fallback permitted');
  const finalSource = git('show', `${head}:${TEST_FILE}`);
  const parsed = parse(finalSource);
  const matches = namedTests(parsed);
  requireEvidence(matches.length === 1, 'final committed test must contain exactly one named regression');
  const selected = matches[0];
  requireEvidence(ts.isIdentifier(selected.expression) && selected.expression.text === 'it' && ts.isExpressionStatement(selected.parent) && selected.arguments.length === 2, 'regression must be an ordinary it-block without focus/skip/budget overrides');
  admissionAssertionLine(parsed, selected);
  const block = selected.parent.getText(parsed);
  writeFileSync(join(attempt, 'selected-test.ts'), block);
  writeFileSync(join(attempt, 'final-test.ts'), finalSource);
  manifest = { ...manifest, finalTestSha256: sha256(finalSource), selectedTestSha256: sha256(block), driverSha256: sha256(readFileSync(new URL(import.meta.url))) };
  save();
  const archive = join(attempt, 'baseline.tar');
  git('archive', '--format=tar', '--output', archive, BASELINE);
  const snapshot = join(attempt, 'snapshot');
  mkdirSync(snapshot);
  execFileSync('tar', ['-xf', archive, '-C', snapshot]);
  const baselinePath = join(snapshot, TEST_FILE);
  const baselineSource = readFileSync(baselinePath, 'utf8');
  const baselineParsed = parse(baselineSource);
  requireEvidence(namedTests(baselineParsed).length === 0, 'baseline already contains named regression; not an independent before-proof');
  const hasReadFileSync = baselineParsed.statements.some((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && ['node:fs', 'fs'].includes(node.moduleSpecifier.text) &&
    node.importClause?.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some((entry) => entry.name.text === 'readFileSync'));
  const overlay = `${hasReadFileSync ? '' : "import { readFileSync } from 'node:fs';\n"}${baselineSource}\n${block}\n`;
  writeFileSync(baselinePath, overlay);
  const overlayParsed = parse(overlay);
  const assertionLine = admissionAssertionLine(overlayParsed, namedTests(overlayParsed)[0]);
  const dependencies = join(root, 'node_modules');
  const cli = join(dependencies, 'vitest', 'vitest.mjs');
  requireEvidence(existsSync(cli), 'installed Vitest CLI missing; no dependency install/fallback permitted');
  symlinkSync(dependencies, join(snapshot, 'node_modules'), 'dir');
  const rpc = join(snapshot, 'tools', 'patch-vitest-rpc-timeout.mjs');
  requireEvidence(existsSync(rpc), 'baseline RPC prerequisite missing; no gate downgrade permitted');
  manifest = { ...manifest, archiveSha256: sha256(readFileSync(archive)), baselineTestSha256: sha256(baselineSource), overlayTestSha256: sha256(overlay), assertionLine, snapshot,
    baselineConfigSha256: sha256(readFileSync(join(snapshot, 'vitest.config.ts'))), baselineBudgetSha256: sha256(readFileSync(join(snapshot, 'test', 'helpers', 'test-budgets.ts'))) };
  save();
  const log = join(attempt, 'complete-output.txt');
  const rpcResult = await run(process.execPath, [rpc], snapshot, log);
  manifest = { ...manifest, rpcResult }; save();
  requireEvidence(rpcResult.exitCode === 0 && rpcResult.signal === null, 'RPC prerequisite failed; not behavioral RED');
  const jsonPath = join(attempt, 'vitest.json');
  const pattern = `^${TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const args = [cli, 'run', TEST_FILE, '-t', pattern, '--reporter=default', '--reporter=json', `--outputFile.json=${jsonPath}`];
  manifest = { ...manifest, command: [process.execPath, ...args], classification: 'running' }; save();
  const result = await run(process.execPath, args, snapshot, log);
  manifest = { ...manifest, childResult: result, outputSha256: sha256(readFileSync(log)) }; save();
  requireEvidence(result.exitCode === 1 && result.signal === null, 'baseline must genuinely fail with exit 1; passing/signalled/setup outcomes are not behavioral RED');
  requireEvidence(existsSync(jsonPath), 'complete Vitest JSON missing; not behavioral RED');
  const rawJson = readFileSync(jsonPath);
  manifest = { ...manifest, vitestJsonSha256: sha256(rawJson) }; save();
  const report = JSON.parse(rawJson.toString('utf8'));
  const message = assertRestartRecoveryBaseline(report, {
    testName: TEST_NAME, testFile: TEST_FILE, assertionLine, output: readFileSync(log, 'utf8'),
  });
  requireEvidence(git('rev-parse', 'HEAD').trim() === head && git('status', '--porcelain', '--untracked-files=normal').trim() === '', 'final authority changed during baseline probe; not attested RED');
  manifest = { ...manifest, classification: 'baseline-assertion-red', admissionAssertion: message, completedAt: new Date().toISOString() }; save();
  console.log(`baseline-assertion-red: baseline=${BASELINE}, final-test=${head}, childExit=1; retained ${attempt}. BEFORE-PROOF ONLY, NOT current-head PASS or READY.`);
  process.exitCode = 1;
} catch (error) {
  manifest = { ...manifest, classification: 'invalid-baseline-proof', error: String(error), completedAt: new Date().toISOString() };
  save();
  console.error(`baseline proof refused: ${String(error)}; retained ${attempt ?? 'no attempt created'}`);
  process.exitCode = 2;
}
}

// Run as the CLI however it was invoked (a relative or symlinked path too);
// an import (the test's) never runs the probe.
const invokedAsCli = (() => {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedAsCli) await main();
