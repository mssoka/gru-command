import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WaveRunner } from '../../src/dispatch/perkins.js';
import { preflightFailure } from '../../src/dispatch/review-path.js';
import type { AgentSpawner } from '../../src/dispatch/service.js';
import { UnavailableWorktreePort } from '../../src/dispatch/worktree-port.js';
import { LedgerApi } from '../../src/ledger/api.js';
import { LedgerDb } from '../../src/ledger/db.js';
import { serviceWorkflowAuthority } from '../../src/workflows/session.js';
import { makeWorkflowLane } from './workflow-lane.js';

/** Real assigned linked lane + service selection + default gate; only the
 * provider/CLI boundary is fake. No ambient resources or external service. */
export function makeFallbackRuntimeHarness(spawner: AgentSpawner, dataDir: string) {
  const f = makeWorkflowLane('j-runtime-fallback');
  writeFileSync(join(f.lane.path, 'candidate.ts'), 'export const candidate = 1;\n');
  execFileSync('git', ['-C', f.lane.path, 'add', '.']);
  execFileSync('git', ['-C', f.lane.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'candidate']);
  const db = new LedgerDb(dataDir);
  const ledger = new LedgerApi(db.handle);
  const job = ledger.addJob({ id: f.lane.id, repo: 'app', title: 'fallback', baseBranch: 'main' });
  ledger.registerWorktree(f.lane);
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: {} });
  class Port extends UnavailableWorktreePort {
    override getWorktree(id: string) { return ledger.getWorktree(id); }
    override listWorktrees() { return ledger.listWorktrees(); }
  }
  const authority = serviceWorkflowAuthority(dataDir, () => ledger);
  const wave = new WaveRunner({
    ledger, worktrees: new Port(), spawner,
    reviewPreflight: async () => ({ ok: false, failures: [preflightFailure('review-policy', 'fixture native gate disabled')] }),
    fallbackGate: { resolveReviewResources: authority.resolveReviewResources, fixDirectiveSink: async () => ({ delivered: false }) },
  });
  return { wave, ledger, authority, job, lane: f.lane,
    close: () => { db.close(); rmSync(f.root, { recursive: true, force: true }); },
  };
}
