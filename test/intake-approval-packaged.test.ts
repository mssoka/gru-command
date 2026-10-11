import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function temp(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-approved-packed-'))); roots.push(root); return root; }
const project = join(import.meta.dirname, '..');
describe('intake approval in the actual distributable', () => {
  const checkArchive = (ambient: boolean): void => {
    const output = temp();
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { filename: string }[];
    execFileSync('tar', ['-xzf', join(output, packed[0]!.filename), '-C', output]);
    const stage = join(output, 'package');
    // Stage the declared config parser dependency offline, as installation
    // does; all product code still comes solely from the npm archive.
    cpSync(join(project, 'node_modules', 'smol-toml'), join(stage, 'node_modules', 'smol-toml'), { recursive: true });
    // A real archive, not imports from src or an ambient BMAD dependency.
    rmSync(join(stage, 'resources', 'bmad-runtime'), { recursive: true, force: true });
    const root = temp(); const repo = join(root, 'workspace', 'app'); mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'spec.md'), 'Implement exact source capture.\n');
    writeFileSync(join(repo, 'story.md'), '---\nstatus: done\n---\nImplement document review.\n');
    if (ambient) { mkdirSync(join(repo, '_bmad')); writeFileSync(join(repo, '_bmad', 'runtime.json'), '{ incompatible BMAD bytes'); }
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const module = (name: string) => JSON.stringify(pathToFileURL(join(stage, 'dist', name)).href);
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, readFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { IntakeService } from ${module('intake/service.js')};
      import { IntakeApprovalService } from ${module('intake/approval.js')};
      import { LedgerApi } from ${module('ledger/api.js')};
      import { LedgerDb } from ${module('ledger/db.js')};
      import { PipelineService } from ${module('dispatch/pipeline.js')};
      import { DispatchService } from ${module('dispatch/service.js')};
      import { createWorkflowSessionBinder, registeredWorkflowLane } from ${module('workflows/session.js')};
      const root = ${JSON.stringify(root)}, repoPath = ${JSON.stringify(repo)}, dataDir = join(root, 'private');
      const db = new LedgerDb(dataDir), ledger = new LedgerApi(db.handle);
      const lanes = new Map(), spawns = [], settlements = [];
      const worktrees = {
        getWorktree: (id) => lanes.get(id) ?? null, listWorktrees: () => [...lanes.values()],
        async createJobWorktree({ repoPath, jobId }) {
          const path = join(root, 'lanes', jobId); mkdirSync(join(root, 'lanes'), { recursive: true });
          const branch = 'gru/' + jobId;
          execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-qb', branch, path], { stdio: 'ignore' });
          const sha = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
          const lane = { id: jobId, kind: 'job', jobId, roundId: null, path, repoPath, repoName: 'app', branch, sha, status: 'active' };
          lanes.set(jobId, lane); return lane;
        },
        async release() { throw new Error('unexpected fixture release'); }
      };
      const bind = createWorkflowSessionBinder(dataDir, (options) => registeredWorkflowLane(options, worktrees, ledger), ${JSON.stringify(stage)});
      const dispatch = new DispatchService({ ledger, worktrees, spawner: async (role, options) => {
        const session = bind(options); spawns.push({ role, options, session });
        assert.equal(role, 'minion'); assert.equal(session.managedSkills.source, 'gru-command-workflows');
        const context = session.managedSkills.workflow.context;
        assert.equal(context.worktreeRoot, options.cwd); assert.equal(context.knowledgeRoot, join(options.cwd, 'gru-output'));
        assert.ok(context.artifactRoot.startsWith(dataDir)); assert.ok(existsSync(session.managedSkills.workflow.contextFile));
        return { id: options.agentId, role, sessionFile: null,
          capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
          prompt: async (text) => { assert.ok(text.includes('BRIEFING:')); }, steer: async () => {}, followUp: async () => {},
          subscribe: () => () => {}, dispose: async () => {}, health: () => ({ state: 'idle', lastActivity: new Date().toISOString(), sessionFile: null }) };
      } });
      let available = 0;
      const pipeline = new PipelineService({ ledger, capacity: () => ({ capacity: 1, occupied: 1 - available, queued: 0, available }), dispatch: { dispatch: async (input) => { const outcome = await dispatch.dispatch(input); settlements.push(outcome.settled); return outcome; } } });
      const intake = new IntakeService({ dataDir, workspaceRoot: join(root, 'workspace'), uploadsDir: join(dataDir, 'uploads'), managedRepos: () => [repoPath], remote: () => ({ host: 'github.com', owner: 'owner', repo: 'app' }), ghRunner: async () => ({ status: 0, stderr: '', stdout: JSON.stringify({ number: 1, html_url: 'https://github.com/owner/app/issues/1', title: 'Capture', body: 'Implement exact source capture.', updated_at: '2026-10-10T12:00:00Z' }) }) });
      const approval = new IntakeApprovalService({ intake, ledger, pipeline });
      const statement = (text) => ({ text, traces: [], clarification: true });
      const requests = [];
      const sources = [{ kind: 'issue', reference: '#1' }, { kind: 'spec', document: { path: 'spec.md' } }, { kind: 'bmad', document: { path: 'story.md' } }];
      for (const source of sources) {
        const first = await intake.preview({ repoPath, intakeId: source.kind, requestId: 'r1', source });
        assert.equal(first.executable, false); assert.equal(ledger.listJobs().length, 0); assert.equal(ledger.listPipelineEntries().length, 0);
        const base = { ...first.plan.heists[0], goal: statement('Implement the captured feature.'), scope: [statement('Implement all mapped acceptance.')], exclusions: [statement('No source or deployment changes.')], acceptance: first.requirements.map(({ id, trace }) => ({ text: trace.quote, traces: [trace], clarification: false, requirementIds: [id] })), verification: [statement('Run npm test.')], unresolvedQuestions: [], splitMergeRationale: statement('A cohesive acceptance boundary.') };
        const plan = { questions: [], unmapped: [], heists: [{ ...base, id: 'selected' }, { ...base, id: 'not-selected' }] };
        const p = await intake.revise({ repoPath, intakeId: source.kind, requestId: 'r2', previousRequestId: 'r1', revisionId: first.revisionId, plan });
        const decision = { repoPath, intakeId: source.kind, requestId: 'r2', revisionId: p.revisionId, expectedToken: null };
        requests.push({ decision, p });
      }
      assert.equal(ledger.listJobs().length, 0); assert.equal(spawns.length, 0);
      for (const { decision, p } of requests) {
        const review = approval.review(decision).review;
        const input = { ...decision, expectedToken: review.token, selected: ['selected'] };
        const accepted = approval.approve(input);
        assert.equal(accepted.accepted.length, 1); assert.equal(accepted.remaining.length, 0);
        assert.deepEqual(approval.approve(input), accepted);
        const entry = pipeline.entry(accepted.accepted[0].entryId);
        assert.deepEqual(JSON.parse(entry.briefing).heist, p.plan.heists[0]);
      }
      assert.equal(ledger.listPipelineEntries().length, 3); assert.equal(ledger.listJobs().length, 0);
      available = 1; pipeline.schedule(); await pipeline.whenIdle(); await Promise.all(settlements); await pipeline.whenIdle();
      assert.equal(spawns.length, 3); assert.equal(ledger.listJobs().length, 3);
      assert.ok(ledger.listPipelineEntries().every((entry) => entry.state === 'admitted'));
      const sourceBytes = readFileSync(join(repoPath, 'spec.md'), 'utf8'); assert.equal(sourceBytes, 'Implement exact source capture.\\n');
      if (${ambient}) assert.equal(readFileSync(join(repoPath, '_bmad/runtime.json'), 'utf8'), '{ incompatible BMAD bytes');
      pipeline.dispose(); db.close(); process.stdout.write('three exact selections admitted with owned workflows and private artifacts');
    `;
    const path = join(root, 'scenario.mjs'); writeFileSync(path, script);
    const result = execFileSync(process.execPath, [path], { cwd: stage, encoding: 'utf8', env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, timeout: 60_000 });
    expect(result).toContain('three exact selections admitted');
    expect(readFileSync(join(repo, 'spec.md'), 'utf8')).toBe('Implement exact source capture.\n');
  };
  it('uses all sources without BMAD and binds only selected accepted work', () => checkArchive(false));
  it('uses all sources with incompatible ambient BMAD without changing unrelated bytes', () => checkArchive(true));
});
