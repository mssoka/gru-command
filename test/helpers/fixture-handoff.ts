import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { WorktreeLane } from '../../src/dispatch/worktree-port.js';
import { LedgerApi } from '../../src/ledger/api.js';
import { LedgerDb } from '../../src/ledger/db.js';
import { assertPendingLaneHandoff, beginLaneHandoff, captureLaneHandoff, completeLaneHandoff } from '../../src/worktrees/handoff.js';
import { repositoryGitEnv } from '../../src/dispatch/perkins-review/artifacts.js';

const owned = new Map<string, WorktreeLane>();
const databases: { readonly db: LedgerDb; readonly root: string }[] = [];
afterEach(() => {
  for (const { db, root } of databases.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); }
  owned.clear();
});

/** Standalone fixtures own an isolated durable issuer; hybrid fixtures must
 * inject their actual test ledger with already-established job/round owners. */
export function standaloneFixtureLedger(jobId: string): LedgerApi {
  const root = mkdtempSync(join(tmpdir(), 'gru-handoff-fixture-'));
  const db = new LedgerDb(root);
  databases.push({ db, root });
  const ledger = new LedgerApi(db.handle);
  ledger.addJob({ id: jobId, repo: 'fixture', title: 'fixture handoff owner' });
  return ledger;
}

/** FIXTURE-ONLY issuance through authentic registration and the same private
 * pending/nonce/unlock/service-ledger proof. No ambient receipt capability. */
export function issueFixtureHandoff(lane: WorktreeLane, ledger: LedgerApi) {
  const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd: lane.path, encoding: 'utf8', env: repositoryGitEnv(false) }).trim();
  if (git(['rev-parse', 'HEAD']) !== lane.sha || git(['rev-parse', '--symbolic-full-name', 'HEAD']) !== (lane.branch === null ? 'HEAD' : `refs/heads/${lane.branch}`)) {
    throw new Error('fixture issuance requires its actual checkout identity');
  }
  const token = `gru-creation:${randomUUID()}`;
  const admin = git(['rev-parse', '--absolute-git-dir']);
  const receipt = join(admin, 'gru-creation-handoff.json');
  if (existsSync(receipt)) {
    const earlier = owned.get(receipt);
    if (earlier === undefined) throw new Error('fixture cannot replace unowned or unresolved issuance');
    captureLaneHandoff(earlier)();
    rmSync(receipt); // only this explicit fixture's proved earlier completed issuance
  }
  git(['worktree', 'lock', '--reason', token, lane.path]);
  if (readFileSync(join(admin, 'locked'), 'utf8').trim() !== token) throw new Error('fixture nonce was not acquired');
  beginLaneHandoff(lane, admin, token);
  const record = ledger.getWorktree(lane.id) ?? ledger.registerWorktree(lane);
  assertPendingLaneHandoff(record, admin, token);
  git(['worktree', 'unlock', lane.path]);
  completeLaneHandoff(record, admin, token, ledger);
  owned.set(receipt, record);
  return record;
}
