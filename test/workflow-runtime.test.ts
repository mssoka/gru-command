import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bindBmadRuntime, inspectMaterializedBmadRuntime, loadBundledBmadRuntime, materializeBmadRuntime } from '../src/bmad/runtime.js';
import { runWorkflowRuntimeCli } from '../src/cli/workflow-runtime.js';
import { parseWorkflowManifest, WORKFLOW_ENTRYPOINTS, WORKFLOW_RESOURCE_DIR, WORKFLOW_SOURCE } from '../src/workflows/manifest.js';
import { bindWorkflowRuntime, createWorkflowRuntimeBinder, loadBundledWorkflowRuntime, renderWorkflow, workflowLauncherCommand, WorkflowResourceError, writeWorkflowManifest, type WorkflowContext } from '../src/workflows/runtime.js';

const repoRoot = join(import.meta.dirname, '..');
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gc-workflows-')));
  cleanup.push(dir);
  return dir;
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}
function fixture(name = 'app'): WorkflowContext {
  const root = temp();
  const projectRoot = join(root, name);
  mkdirSync(projectRoot);
  git(projectRoot, ['init', '-q']);
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
  return { projectId: 'registered-17', jobId: 'j-42', projectRoot, worktreeRoot: projectRoot,
    artifactRoot: join(root, 'private', 'j-42'), knowledgeRoot: join(projectRoot, 'gru-output') };
}
function packageCopy(): string {
  const root = temp();
  cpSync(join(repoRoot, WORKFLOW_RESOURCE_DIR), join(root, WORKFLOW_RESOURCE_DIR), { recursive: true });
  return root;
}
function runtime() { return materializeBmadRuntime(loadBundledWorkflowRuntime(repoRoot), temp()); }
function textAt(snapshot: string, name: string): string { return readFileSync(join(snapshot, 'skills/gc-build', name), 'utf-8'); }

// Do not load at module scope: a missing package must fail the actual test, not silently collect zero.
describe('GC-owned workflow resources', () => {
  it('has a GC identity, ordinary local integrity, license/attribution and its own build verifier', () => {
    const bundle = loadBundledWorkflowRuntime(repoRoot);
    expect(bundle.id).toBe('gru-command-workflows@2');
    expect(bundle.manifest).not.toHaveProperty('upstream');
    expect(bundle.manifest).not.toHaveProperty('customization');
    expect(bundle.files.get('LICENSE')!.toString()).toContain('MIT License');
    expect(bundle.files.get('NOTICE.md')!.toString()).toContain('BMad Code, LLC');
    expect(bundle.manifest.entrypoints).toEqual(WORKFLOW_ENTRYPOINTS);
    const output: string[] = [];
    expect(runWorkflowRuntimeCli(['verify', repoRoot], (line) => output.push(line))).toBe(0);
    expect(output[0]).toContain(bundle.contentSha256);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts: { build: string }; files: string[] };
    expect(pkg.scripts.build).toContain('node dist/cli/workflow-runtime.js verify .');
    expect(pkg.files).toContain(`${WORKFLOW_RESOURCE_DIR}/`);
  });

  it('edits templates and helpers with only a local manifest refresh, not an upstream install/archive', () => {
    const root = packageCopy();
    const before = loadBundledWorkflowRuntime(root);
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\nGC-maintained planning rule.\n');
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'scripts/render.mjs'), '\n// GC-maintained helper change.\n');
    expect(() => loadBundledWorkflowRuntime(root)).toThrow(/does not match its sha256/u);
    const lines: string[] = [];
    runWorkflowRuntimeCli(['manifest', root, '--version', '3'], (line) => lines.push(line));
    const after = loadBundledWorkflowRuntime(root);
    expect(after.id).toBe('gru-command-workflows@3');
    expect(after.contentSha256).not.toBe(before.contentSha256);
    expect(lines[0]).toContain('owned local resources');
    const invocation = renderWorkflow(materializeBmadRuntime(after, temp()), fixture());
    expect(textAt(invocation.snapshotDir, 'plan.md')).toContain('GC-maintained planning rule.');
    expect(existsSync(join(root, 'resources/bmad-runtime'))).toBe(false);
    expect(existsSync(join(root, '_bmad'))).toBe(false);
  });

  it('rejects missing, corrupt, undeclared and symlinked resources by name without ambient fallback', () => {
    const cases: Array<[string, (dir: string) => void, RegExp]> = [
      ['missing helper', (dir) => rmSync(join(dir, 'scripts/render.mjs')), /scripts\/render\.mjs/u],
      ['missing validator', (dir) => rmSync(join(dir, 'scripts/context.mjs')), /scripts\/context\.mjs/u],
      ['corrupt template', (dir) => appendFileSync(join(dir, 'skills/gc-build/small-change.md'), 'changed'), /small-change\.md.*sha256/u],
      ['undeclared', (dir) => writeFileSync(join(dir, 'extra.txt'), 'x'), /undeclared.*extra\.txt/u],
      ['prototype-named undeclared file', (dir) => writeFileSync(join(dir, 'toString'), 'x'), /undeclared.*toString/u],
      ['another prototype-named undeclared file', (dir) => writeFileSync(join(dir, 'constructor'), 'x'), /undeclared.*constructor/u],
      ['missing manifest', (dir) => rmSync(join(dir, 'runtime.json')), /missing runtime\.json/u],
      ['symlink', (dir) => { rmSync(join(dir, 'scripts/render.mjs')); symlinkSync(join(repoRoot, WORKFLOW_RESOURCE_DIR, 'scripts/render.mjs'), join(dir, 'scripts/render.mjs')); }, /symlink.*render\.mjs/u],
    ];
    for (const [label, mutate, message] of cases) {
      const root = packageCopy();
      mutate(join(root, WORKFLOW_RESOURCE_DIR));
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(WorkflowResourceError);
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(message);
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(/no ambient workflow fallback/u);
    }
    const root = packageCopy();
    rmSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/review-prompts/verification.md'));
    expect(() => writeWorkflowManifest(root)).toThrow(/lacks required resource.*verification\.md/u);
  });

  it('rejects malformed identities, path declarations, omitted required helpers and broken reference closure', () => {
    const bundle = loadBundledWorkflowRuntime(repoRoot);
    for (const patch of [{ schema_version: 9 }, { id: 'bmad@latest' }, { version: 0 }, { name: 'external' }, { skills: [] }, { entrypoints: {} }, { files: { '../outside': '0'.repeat(64) } }]) {
      expect(() => parseWorkflowManifest(JSON.stringify({ ...bundle.manifest, ...patch }), 'fixture')).toThrow(WorkflowResourceError);
    }
    expect(() => parseWorkflowManifest('not-json', 'fixture')).toThrow(/not valid JSON/u);
    const root = packageCopy();
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\n[[gc-resource:skills/gc-build/omitted-helper.md]]\n');
    expect(() => writeWorkflowManifest(root)).toThrow(/references missing.*omitted-helper\.md/u);
    const badContext = packageCopy();
    appendFileSync(join(badContext, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\n{{context.unknown}}\n');
    expect(() => writeWorkflowManifest(badContext)).toThrow(/unknown context field unknown/u);
    const badPlugin = packageCopy();
    writeFileSync(join(badPlugin, WORKFLOW_RESOURCE_DIR, '.claude-plugin/plugin.json'), 'not JSON');
    expect(() => writeWorkflowManifest(badPlugin)).toThrow(/\.claude-plugin\/plugin\.json is not valid JSON/u);
  });

  it('resolves complete normal/small/review/planning routes from only packaged bytes and explicit context', () => {
    const context = fixture();
    const retained = runtime();
    for (const [route, entry] of Object.entries(WORKFLOW_ENTRYPOINTS)) {
      const invocation = renderWorkflow(retained, context, route as keyof typeof WORKFLOW_ENTRYPOINTS);
      expect(invocation.entrypoint).toBe(join(invocation.snapshotDir, entry));
      expect(invocation.snapshotDir.startsWith(context.artifactRoot)).toBe(true);
      expect(JSON.parse(readFileSync(invocation.contextFile, 'utf-8'))).toEqual({ ...context, runtimeId: retained.id, contentSha256: retained.contentSha256 });
      const sources = readdirSync(join(invocation.snapshotDir, 'skills'), { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
      for (const file of sources) {
        const text = readFileSync(join(file.parentPath, file.name), 'utf-8');
        expect(text).not.toMatch(/\[\[gc-resource:|\{\{context\.|_bmad|bmad-build|bmad-review/u);
        for (const line of text.split('\n')) {
          for (const target of line.matchAll(new RegExp(`${invocation.snapshotDir}/skills/[A-Za-z0-9./-]+\\.md`, 'gu'))) {
            expect(existsSync(target[0]), target[0]).toBe(true);
          }
        }
      }
      expect(readFileSync(invocation.entrypoint, 'utf-8')).toContain(context.jobId);
    }
    expect(git(context.worktreeRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const snapshot = renderWorkflow(retained, context).snapshotDir;
    expect(existsSync(join(snapshot, 'skills/gc-build/SKILL.md'))).toBe(false);
    expect(existsSync(join(retained.skillsDir, 'gc-build/SKILL.md'))).toBe(true);
    expect(existsSync(join(context.worktreeRoot, '_bmad'))).toBe(false);
    expect(existsSync(context.knowledgeRoot)).toBe(false); // no premature repository writes
  });

  it('both routes preserve independent tracked review, reasoned fixes, verification and ordinary PR handoff without quotas', () => {
    const invocation = renderWorkflow(runtime(), fixture());
    const review = textAt(invocation.snapshotDir, 'review.md');
    const small = textAt(invocation.snapshotDir, 'small-change.md');
    expect(review).toContain('fresh, context-free reviewers');
    expect(review).toContain('actual run/session/pane identity');
    expect(review).toContain('reasoned disposition');
    expect(review).toContain('Re-engage independent reviewers');
    expect(small).toContain('genuinely independent adversarial reviewer');
    for (const text of [review, small]) {
      expect(text).toContain('No actionable findings.');
      expect(text).toContain('no total/per-phase tool-call ceiling');
      expect(text).not.toMatch(/find at least|finding floor|at most \d+ tool|minimum \d+ finding/iu);
    }
    expect(textAt(invocation.snapshotDir, 'present.md')).toContain('ordinary non-draft PR');
    expect(textAt(invocation.snapshotDir, 'present.md')).toContain('fallback or development PASS must never be presented as native READY');
    expect(textAt(invocation.snapshotDir, 'workflow.md')).toContain('small-change.md');
  });

  it('review commissions four lenses with fixed roles, sizes small-change review by risk and triages with one verdict per finding', () => {
    const invocation = renderWorkflow(runtime(), fixture());
    const review = textAt(invocation.snapshotDir, 'review.md');
    const intent = textAt(invocation.snapshotDir, 'review-prompts/intent-alignment.md');
    const bullet = (lens: string): string => {
      const start = review.indexOf(join(invocation.snapshotDir, `skills/gc-build/review-prompts/${lens}.md`));
      expect(start, lens).toBeGreaterThan(-1);
      const rest = review.slice(start);
      return rest.slice(0, rest.search(/\n(?:- |\n)/u));
    };
    expect(review).toContain('The normal route uses all four lenses');
    // Each lens is tied to its dispatch role: only the adversarial lens is blind.
    expect(bullet('adversarial')).toContain('"review_role": "blind"');
    for (const lens of ['edge-cases', 'verification', 'intent-alignment']) {
      expect(bullet(lens), lens).toContain('"review_role": "claims"');
      expect(bullet(lens), lens).not.toContain('"review_role": "blind"');
    }
    expect(bullet('adversarial')).not.toContain('"review_role": "claims"');
    // The path tracer gets no claims; the verification lens falsifies them.
    expect(bullet('edge-cases')).toMatch(/only: never the spec, intent, task list or author's explanation, so nothing steers\s+its path tracing\. Commission it with `"review_role": "claims"` and no\s+`required_inputs`/u);
    expect(bullet('verification')).toMatch(/the working spec's acceptance and tasks as the claims it falsifies/u);
    expect(bullet('intent-alignment')).toMatch(/plus the verbatim owner-approved intent quoted into the brief; never the author's\s+explanation, task list or self-review/u);
    expect(intent).toMatch(/surface at\s+which\s+the intent's\s+expectations\s+live/u);
    expect(intent).toMatch(/internal proxy/u);
    // Risk sizes small-change review, is re-scored against the diff and raised lenses run on the same head.
    expect(review).toMatch(/`medium` adds the verification and\s+edge-case lenses, `high` uses all four, and an unrecorded risk counts as `high`/u);
    expect(review).toMatch(/A risk raised during review commissions the lenses it now requires on the same\s+head before review concludes/u);
    const small = textAt(invocation.snapshotDir, 'small-change.md');
    expect(small).toMatch(/the change's risk \(`low`, `medium`\s+or `high`: the business impact if it is wrong/u);
    expect(small).toMatch(/never lowered once a reviewer has run/u);
    expect(small).toMatch(/re-score the risk against that diff, raising it when the change reaches more\s+than step 1 expected/u);
    expect(small).toMatch(/`medium` adds the verification and edge-case\s+lenses, `high` uses all four/u);
    // Triage waits for every lens or records its failure; a failed blind report is never coverage.
    expect(review).toMatch(/Triage only after every launched reviewer has reported or ended without a report\./u);
    expect(review).toMatch(/is a failed lens: record it,\s+re-commission it or report the infrastructure failure as above, and treat that\s+lens's coverage as missing until a replacement reports/u);
    expect(review).toMatch(/A failed blind report never counts as coverage,\s+whatever `blind-coverage` says; if its replacement is refused\s+`409 blind_coverage_owned`, do not retry in a loop/u);
    // Exactly one defined verdict per finding.
    expect(review).toMatch(/Disregard any severity a reviewer assigned/u);
    expect(review).toMatch(/Render exactly one verdict:/u);
    expect(review).toMatch(/- `high` \(intolerable\), `medium` \(tolerable\) or `low` \(cosmetic or negligible\) —\s+the bad outcome is real/u);
    expect(review).toMatch(/- `false` — you checked and the outcome does not occur/u);
    expect(review).toMatch(/- `maybe-false` — the diff and surrounding code cannot decide it/u);
    expect(review).toMatch(/Code that fails loudly on a state you have not shown the program can reach is\s+correct behavior, not a defect/u);
    // Carried rows: only rejected/owner-ruled/pre-existing rows whose code, evidence, intent and paths are unchanged.
    expect(review).toMatch(/Carry a row forward only when all of these hold: its disposition is\s+rejected, owner ruling or pre-existing/u);
    expect(review).toMatch(/the cited code, the code its\s+evidence relied on and the approved intent are unchanged and no change adds a new\s+caller of or path into the cited code/u);
    expect(review).toMatch(/keeping its\s+original verdict and disposition, without re-verifying it/u);
    expect(review).toMatch(/A finding that matches\s+a row that is fixed, awaiting an owner decision or unsettled is verified again/u);
    // Owner ruling 2026-10-17: unlikely low findings whose fix adds complexity are rejected.
    expect(review).toMatch(/Reject a `low` finding when users or\s+developers are unlikely to meet the defect in everyday use/u);
    expect(review).toMatch(/new\s+guards, branches, parameters or other complexity/u);
    expect(review).toMatch(/only when the approved intent itself\s+excludes it/u);
    // Routing replaces BMAD's defer list; only owner-approved acceptance needs the owner.
    expect(review).toMatch(/Group the survivors by shared root cause — the same defect produced both, not\s+merely the same location or the same fix — and give each group its highest\s+verdict/u);
    expect(review).toMatch(/One that cannot be settled is logged as unsettled and named in the\s+handoff with what would settle it/u);
    expect(review).toMatch(/log it as pre-existing with\s+its evidence and name it in the handoff; do not open new backlog for it/u);
    expect(review).toMatch(/Findings that expose wrong owner-approved acceptance need an explicit owner\s+decision/u);
    expect(review).toMatch(/A wrong\s+planning detail that is not owner-approved acceptance \(an I\/O matrix row, a task\)\s+is corrected in the spec with the approved-intent text it contradicts quoted,\s+and the correction is named in the handoff/u);
    expect(review).toContain('Do not offload known required work into new backlog.');
    expect(review).not.toMatch(/deferred-work|defer list/iu);
    expect(textAt(invocation.snapshotDir, 'present.md')).toMatch(/the recorded\s+risk and review outcome — naming every finding not fixed in this change/u);
  });

  it('lenses carry the verification-gap and path-tracing methods, and planning carries risk and the I/O matrix audit', () => {
    const invocation = renderWorkflow(runtime(), fixture());
    const verification = textAt(invocation.snapshotDir, 'review-prompts/verification.md');
    for (const shape of ['Regression gap', 'Missing-adoption gap', 'Broken-verification gap', 'Acceptance-evidence gap']) expect(verification).toContain(shape);
    expect(verification).toMatch(/name the Demonstration: the smallest realistic regression/u);
    expect(verification).toMatch(/search the whole repository by the symbol under\s+test and by import references/u);
    expect(verification).toMatch(/source-text assertions that match a file's wording/u);
    expect(verification).toContain('`expect(x ?? DEFAULT).toBe(DEFAULT)` passes when `x` is missing');
    expect(verification).toMatch(/## Claims\s+After tracing verification, take the working spec's intent, acceptance and tasks/u);
    expect(verification).toMatch(/testimony, not evidence/u);
    expect(verification).toMatch(/If the diff, approved\s+intent or claims your brief names are missing, empty or unreadable, say exactly\s+that and stop/u);
    const edges = textAt(invocation.snapshotDir, 'review-prompts/edge-cases.md');
    expect(edges).toMatch(/report only what the change leaves\s+unhandled: reachable paths and boundaries, and removed contracts/u);
    expect(edges).toMatch(/Your brief\s+carries no claims about the change; do not seek the author's spec, intent or task\s+list, so nothing steers the trace/u);
    expect(edges).toMatch(/Implicit branches:/u);
    expect(edges).toMatch(/Handle lifetime:/u);
    expect(edges).toMatch(/read the callee's declaration/u);
    expect(edges).toMatch(/where\s+removed code was referenced, and where other writers or readers share the state/u);
    expect(edges).toMatch(/assign severity or confidence/u);
    expect(edges).not.toMatch(/high\/medium\/low\s+confidence|claims input/u);
    for (const lens of [verification, edges, textAt(invocation.snapshotDir, 'review-prompts/intent-alignment.md')]) {
      expect(lens).toContain('No actionable findings.');
      expect(lens).toMatch(/Do not rank or\s+assign severity|no severity, confidence or\s+ranking/u);
      expect(lens).not.toMatch(/find at least|finding floor|do not stop with an empty/iu);
    }
    const spec = textAt(invocation.snapshotDir, 'spec-template.md');
    expect(spec).toMatch(/## Risk\s+`low`, `medium` or `high` — the business impact if this change is wrong/u);
    expect(spec).toMatch(/This route always reviews with all four lenses; the\s+small-change route records the same field in its note, where it sizes review\s+breadth/u);
    expect(spec).toContain('| Scenario | Input / state | Expected output / behavior | Error handling |');
    expect(spec).toMatch(/outermost surface the intent names/u);
    expect(spec).toMatch(/## Review triage log\s+Append one row per reviewer finding on every review pass, carried rows included:\s+reviewed head/u);
    expect(spec).toMatch(/owner ruling with the ruling, owner decision pending,\s+pre-existing, or unsettled with what would settle it/u);
    expect(spec).toMatch(/A carried row is marked\s+`carried` and keeps its original verdict and disposition/u);
    expect(textAt(invocation.snapshotDir, 'plan.md')).toMatch(/Score its risk from the investigation/u);
    const implement = textAt(invocation.snapshotDir, 'implement.md');
    expect(implement).toMatch(/\(unregistered, filtered out,\s+skipped or disabled\) counts as missing/u);
    expect(implement).toMatch(/never\s+edit the expectation to match the code/u);
    expect(implement).toMatch(/A row that is itself wrong\s+against the approved intent is corrected in the spec with the approved-intent text\s+it contradicts quoted, and the correction is named in the handoff; a row that\s+encodes owner-approved acceptance changes only on an owner decision/u);
  });

  it('a lane bound to the shipped @1 package keeps its retained copy after @2 replaces the package in place, while a new lane binds @2', () => {
    // Exact bytes of gru-command-workflows@1 as shipped at 408250ac; live lanes are bound to these.
    const shippedRoot = join(repoRoot, 'test/fixtures/gc-workflows-v1');
    const shipped = loadBundledWorkflowRuntime(shippedRoot);
    expect(shipped.id).toBe('gru-command-workflows@1');
    expect(shipped.contentSha256).toBe('d0bd8c82f608ab1d70fbc468509a6c6f8d1c731fad4964aec6d431b4e6700bc5');
    // The installed package root is upgraded in place, as an install update does.
    const installed = temp();
    cpSync(join(shippedRoot, WORKFLOW_RESOURCE_DIR), join(installed, WORKFLOW_RESOURCE_DIR), { recursive: true });
    const context = fixture();
    const old = join(dirname(context.projectRoot), 'bound-v1');
    const fresh = join(dirname(context.projectRoot), 'fresh-v2');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'bound-v1', old]);
    git(context.projectRoot, ['worktree', 'add', '-qb', 'fresh-v2', fresh]);
    const store = temp();
    const a = createWorkflowRuntimeBinder(store, installed)(old);
    expect(a.runtimeId).toBe('gru-command-workflows@1');
    expect(a.root.startsWith(`${store}/`)).toBe(true);
    rmSync(join(installed, WORKFLOW_RESOURCE_DIR), { recursive: true });
    cpSync(join(repoRoot, WORKFLOW_RESOURCE_DIR), join(installed, WORKFLOW_RESOURCE_DIR), { recursive: true });
    const current = createWorkflowRuntimeBinder(store, installed);
    expect(current(old)).toEqual(a);
    expect(current(fresh).runtimeId).toBe('gru-command-workflows@2');
    const rendered = renderWorkflow({ id: a.runtimeId, dir: a.root, contentSha256: a.contentSha256, skillsDir: a.skillsDir, skills: a.skills },
      { ...context, worktreeRoot: old, knowledgeRoot: join(old, 'gru-output') }, 'review');
    const review = readFileSync(rendered.entrypoint, 'utf-8');
    expect(review).toContain('The normal route uses all three lenses');
    expect(review).not.toContain('intent-alignment');
  });

  it('ignores absent, broken or symlinked ambient BMAD and does not modify its files', () => {
    const context = fixture();
    const elsewhere = temp();
    writeFileSync(join(elsewhere, 'config.toml'), 'broken; do not read\n');
    symlinkSync(elsewhere, join(context.worktreeRoot, '_bmad'));
    const ancestor = join(dirname(context.worktreeRoot), '_bmad');
    mkdirSync(ancestor);
    writeFileSync(join(ancestor, 'renderer.py'), 'raise RuntimeError("ambient")\n');
    const retained = runtime();
    const home = temp();
    mkdirSync(join(home, '.agents/skills/bmad-build'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/bmad-build/SKILL.md'), 'HALT ambient\n');
    const contextFile = join(temp(), 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const launcher = workflowLauncherCommand(retained, contextFile);
    const result = spawnSync('/bin/sh', ['-c', launcher.command], { cwd: context.worktreeRoot, env: { HOME: home, PATH: process.env.PATH, ...launcher.env }, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('read and follow ');
    expect(readFileSync(join(elsewhere, 'config.toml'), 'utf-8')).toBe('broken; do not read\n');
    expect(readFileSync(join(ancestor, 'renderer.py'), 'utf-8')).toContain('ambient');
    expect(lstatSync(join(context.worktreeRoot, '_bmad')).isSymbolicLink()).toBe(true);
  });

  it('handles quoted shell-special paths inertly through its own launcher and explicit stdin API', () => {
    const context = fixture('app quotes \' " $(not-executed)');
    const retained = runtime();
    const contextFile = join(temp(), 'context quotes \' " $(not-executed).json');
    writeFileSync(contextFile, JSON.stringify(context));
    const launcher = workflowLauncherCommand(retained, contextFile, 'small-change');
    const result = spawnSync('/bin/sh', ['-c', launcher.command], { env: { PATH: process.env.PATH, HOME: temp(), ...launcher.env }, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    const entry = result.stdout.trim().slice('read and follow '.length);
    expect(readFileSync(entry, 'utf-8')).toContain(context.worktreeRoot);
    expect(renderWorkflow(retained, context, 'small-change').entrypoint).toBe(entry);
    expect(result.stderr).toBe('');
  });

  it('rejects missing explicit identity, unsafe output roots, symlinks and unsupported routes before writing', () => {
    const retained = runtime();
    for (const patch of [{ projectId: '' }, { jobId: '../other' }, { projectRoot: 'relative' }, { artifactRoot: 'relative' }, { knowledgeRoot: '/outside' }]) {
      const context = { ...fixture(), ...patch };
      expect(() => renderWorkflow(retained, context)).toThrow(WorkflowResourceError);
      expect(existsSync(context.artifactRoot)).toBe(false);
    }
    const context = fixture();
    expect(() => renderWorkflow(retained, { ...context, artifactRoot: join(context.worktreeRoot, 'private') })).toThrow(/outside project/u);
    expect(() => renderWorkflow(retained, { ...context, artifactRoot: retained.dir })).toThrow(/outside project/u);
    expect(() => renderWorkflow(retained, { ...context, knowledgeRoot: context.worktreeRoot })).toThrow(/beneath the assigned/u);
    const external = temp();
    symlinkSync(external, join(context.worktreeRoot, 'gru-output'));
    expect(() => renderWorkflow(retained, context)).toThrow(/symlink/u);
    expect(readdirSync(external)).toEqual([]);
    expect(() => renderWorkflow(retained, fixture(), 'unknown' as 'normal')).toThrow(/unsupported/u);
  });

  it('separates two projects/jobs and keeps snapshots and retained resources immutable', () => {
    const retained = runtime();
    const first = fixture('alpha');
    const second = fixture('beta');
    const a = renderWorkflow(retained, first);
    const b = renderWorkflow(retained, { ...second, jobId: 'j-43' });
    const c = renderWorkflow(retained, { ...first, jobId: 'j-44', artifactRoot: join(dirname(first.artifactRoot), 'j-44') });
    expect(new Set([a.snapshotDir, b.snapshotDir, c.snapshotDir]).size).toBe(3);
    expect(readFileSync(b.entrypoint, 'utf-8')).not.toContain(first.worktreeRoot);
    expect(renderWorkflow(retained, first)).toEqual(a);
    expect(inspectMaterializedBmadRuntime(retained.dir).contentSha256).toBe(retained.contentSha256);
    chmodSync(a.entrypoint, 0o600);
    appendFileSync(a.entrypoint, 'tampered');
    expect(() => renderWorkflow(retained, first)).toThrow(/snapshot is missing\/modified/u);
    expect(readFileSync(a.entrypoint, 'utf-8')).toContain('tampered');
  });

  it('a lane bound to A retains A when B ships while a new lane can use B', () => {
    const context = fixture();
    const one = join(dirname(context.projectRoot), 'lane-one');
    const two = join(dirname(context.projectRoot), 'lane-two');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'one', one]);
    git(context.projectRoot, ['worktree', 'add', '-qb', 'two', two]);
    const store = temp();
    const rootB = packageCopy();
    writeWorkflowManifest(rootB, 3);
    const bindA = createWorkflowRuntimeBinder(store, repoRoot);
    const bindB = createWorkflowRuntimeBinder(store, rootB);
    const a = bindA(one);
    expect(bindB(one)).toEqual(a);
    expect(bindB(two).runtimeId).toBe('gru-command-workflows@3');
    expect(a).toMatchObject({ source: WORKFLOW_SOURCE, runtimeId: 'gru-command-workflows@2', laneBound: true });
    const originalRecord = readFileSync(join(git(one, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'), 'utf-8');
    rmSync(a.root, { recursive: true });
    expect(() => bindB(one)).toThrow(/never switches runtimes/u);
    expect(readFileSync(join(git(one, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'), 'utf-8')).toBe(originalRecord);
  });

  it('reads retained #283 lane bindings without loading the new package or replacing identity/skills', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'historical');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'historical', lane]);
    const store = temp();
    const original = bindBmadRuntime(lane, { storeRoot: store, bundled: () => loadBundledBmadRuntime(repoRoot) });
    const oldRecord = readFileSync(original.bindingFile!, 'utf-8');
    const preserved = createWorkflowRuntimeBinder(store, temp())(lane); // no current package exists at all
    expect(preserved).toMatchObject({ source: 'gru-command-bmad', runtimeId: original.id, root: original.dir, skills: ['bmad-build'] });
    expect(readFileSync(original.bindingFile!, 'utf-8')).toBe(oldRecord);
    expect(inspectMaterializedBmadRuntime(original.dir).contentSha256).toBe(original.contentSha256);
  });

  it('keeps the first binding during a publication race even when the losing writer has another package', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'race');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'race', lane]);
    const store = temp();
    const a = loadBundledWorkflowRuntime(repoRoot);
    const rootB = packageCopy();
    writeWorkflowManifest(rootB, 3);
    const b = loadBundledWorkflowRuntime(rootB);
    const result = bindWorkflowRuntime(lane, { storeRoot: store, bundled: () => b,
      beforePublish: () => { bindWorkflowRuntime(lane, { storeRoot: store, bundled: () => a }); } });
    expect(result.id).toBe(a.id);
    expect(readdirSync(dirname(result.bindingFile!))).toEqual(['bmad-runtime.json']);
  });

  it('refuses corrupted retained bytes by name and restores a missing runtime only from identical shipped bytes', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'restore');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'restore', lane]);
    const store = temp();
    const bind = createWorkflowRuntimeBinder(store, repoRoot);
    const a = bind(lane);
    rmSync(a.root, { recursive: true });
    expect(bind(lane)).toEqual(a);
    const target = join(a.root, 'skills/gc-build/review.md');
    chmodSync(target, 0o600);
    appendFileSync(target, 'corrupt');
    expect(() => bind(lane)).toThrow(/review\.md.*sha256/u);
    expect(readFileSync(target, 'utf-8')).toContain('corrupt');
  });

  it('rejects full CLI context before creating a runtime store or publishing a lane binding', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'invalid-context-lane');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'invalid-context', lane]);
    const valid = { ...context, worktreeRoot: lane, knowledgeRoot: join(lane, 'gru-output') };
    const store = join(temp(), 'store-must-remain-absent');
    const bindingFile = join(git(lane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json');
    const file = join(temp(), 'context.json');
    const external = temp();
    const publicArtifacts = join(temp(), 'public-artifacts');
    mkdirSync(publicArtifacts);
    chmodSync(publicArtifacts, 0o755);
    const linkedKnowledge = join(lane, 'linked-knowledge');
    symlinkSync(external, linkedKnowledge);
    for (const patch of [{ projectId: '' }, { jobId: '' }, { artifactRoot: join(lane, 'private') },
      { knowledgeRoot: external }, { knowledgeRoot: linkedKnowledge }, { artifactRoot: publicArtifacts }, { artifactRoot: join(store, 'wrong-place') }]) {
      writeFileSync(file, JSON.stringify({ ...valid, ...patch }));
      expect(() => runWorkflowRuntimeCli(['render', '--context', file, '--store', store, '--package-root', repoRoot], () => {})).toThrow(WorkflowResourceError);
      expect(existsSync(bindingFile), JSON.stringify(patch)).toBe(false);
      expect(existsSync(store), JSON.stringify(patch)).toBe(false);
      expect(existsSync(valid.artifactRoot)).toBe(false);
    }
    const packageB = packageCopy();
    writeWorkflowManifest(packageB, 3);
    writeFileSync(file, JSON.stringify(valid));
    const output: string[] = [];
    runWorkflowRuntimeCli(['render', '--context', file, '--store', store, '--package-root', packageB], (line) => output.push(line));
    expect(JSON.parse(output[0]!)).toMatchObject({ runtimeId: 'gru-command-workflows@3' });
    expect(JSON.parse(readFileSync(bindingFile, 'utf-8'))).toMatchObject({ runtime_id: 'gru-command-workflows@3' });
  });

  it('CLI invocation validates a bound lane under retained A, not the installed B validator', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'retained-validation');
    const fresh = join(dirname(context.projectRoot), 'new-validation');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'retained-validation', lane]);
    git(context.projectRoot, ['worktree', 'add', '-qb', 'new-validation', fresh]);
    const store = join(temp(), 'store');
    const file = join(temp(), 'context.json');
    const valid = { ...context, projectId: 'legacy', worktreeRoot: lane, knowledgeRoot: join(lane, 'gru-output') };
    writeFileSync(file, JSON.stringify(valid));
    const invoke = (packageRoot: string): { runtimeId: string } => {
      const output: string[] = [];
      runWorkflowRuntimeCli(['render', '--context', file, '--store', store, '--package-root', packageRoot], (line) => output.push(line));
      return JSON.parse(output[0]!) as { runtimeId: string };
    };
    expect(invoke(repoRoot).runtimeId).toBe('gru-command-workflows@2');
    const bindingFile = join(git(lane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json');
    const original = readFileSync(bindingFile, 'utf-8');
    rmSync((JSON.parse(original) as { runtime_dir: string }).runtime_dir, { recursive: true });
    expect(invoke(repoRoot).runtimeId).toBe('gru-command-workflows@2'); // identical-byte restoration after validation
    expect(readFileSync(bindingFile, 'utf-8')).toBe(original);
    const packageB = packageCopy();
    const validator = join(packageB, WORKFLOW_RESOURCE_DIR, 'scripts/context.mjs');
    writeFileSync(validator, readFileSync(validator, 'utf-8').replace('export function validateContext(raw, protectedRoots = []) {',
      'export function validateContext(raw, protectedRoots = []) {\n  if (raw?.projectId === "legacy") throw new Error("B rejects legacy");'));
    writeWorkflowManifest(packageB, 3);
    expect(invoke(packageB).runtimeId).toBe('gru-command-workflows@2');
    expect(readFileSync(bindingFile, 'utf-8')).toBe(original);
    const next = { ...valid, worktreeRoot: fresh, knowledgeRoot: join(fresh, 'gru-output'), artifactRoot: join(temp(), 'new-job') };
    writeFileSync(file, JSON.stringify(next));
    expect(() => invoke(packageB)).toThrow(/B rejects legacy/u);
    expect(existsSync(join(git(fresh, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'))).toBe(false);
    expect(existsSync(next.artifactRoot)).toBe(false);
    rmSync(join(packageB, WORKFLOW_RESOURCE_DIR), { recursive: true });
    writeFileSync(file, JSON.stringify(valid));
    expect(invoke(packageB).runtimeId).toBe('gru-command-workflows@2'); // no current bundle available
  });

  it('the explicit render CLI records the bound workflow and rejects incomplete/unknown arguments', () => {
    const context = fixture();
    const file = join(temp(), 'context.json');
    writeFileSync(file, JSON.stringify(context));
    const lines: string[] = [];
    runWorkflowRuntimeCli(['render', '--context', file, '--store', temp(), '--package-root', repoRoot, '--route', 'small-change'], (line) => lines.push(line));
    expect(JSON.parse(lines[0]!)).toMatchObject({ runtimeId: 'gru-command-workflows@2' });
    for (const args of [[], ['verify', '--bogus'], ['manifest', repoRoot, '--version', '0'], ['render', '--context', file], ['render', '--unknown', 'x']]) {
      expect(() => runWorkflowRuntimeCli(args, () => {})).toThrow(/usage:/u);
    }
  });
});
