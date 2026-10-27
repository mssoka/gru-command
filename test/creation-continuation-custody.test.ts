import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DispatchService } from '../src/dispatch/service.js';
import { JobExecutionStop } from '../src/dispatch/job-stop.js';
import type { DiskFloorGate, FloorAdmission } from '../src/maintenance/disk.js';
import { clearCreationIntent, readCreationIntent, writeCreationIntent } from '../src/worktrees/creation-intent.js';
import type { LogLevel } from '../src/logger.js';
import { attachBareOrigin } from './helpers/fixture-repo.js';
import {
  acceptDirectly, cleanupContinuationFixtures, committedExitWithoutClose, committedStall, directory, fakeHandle, git, hasRawCreationToken, httpHarness,
  managerFixture, processGone, receiptFiles, request, retainedFixture, sha256, syntheticRetained, TOKEN, waitForState, type RetainedFixture,
} from './helpers/creation-continuation.js';

afterEach(cleanupContinuationFixtures);

/** A disk floor that queues every lane until released; its signal ends the wait. */
function heldFloor() {
  let release: (() => void) | null = null;
  const floor: Pick<DiskFloorGate, 'admitLane'> = {
    admitLane: (input) => new Promise<FloorAdmission>((resolve, reject) => {
      input.queued?.({ reason: 'fixture disk floor below threshold', position: 1 });
      input.signal?.addEventListener('abort', () => reject(new Error(`disk floor wait ended: ${String(input.signal?.reason)}`)), { once: true });
      release = () => resolve({ waitedMs: 1, done() {} });
    }),
  };
  return { floor, release: () => release!() };
}

function logSink() {
  const entries: { readonly level: LogLevel; readonly msg: string; readonly fields: Record<string, unknown> }[] = [];
  return { entries, log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => { entries.push({ level, msg, fields: fields ?? {} }); } };
}

/** Put a synthetic git first on PATH that locks a lane's tree with its own
 * creation token immediately before delegating `worktree remove` (the
 * after-proof window), and delegates every other command unchanged. Returns
 * the PATH to restore. */
function lockBeforeRemovalGit(): string {
  const root = directory();
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const script = join(root, 'git');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    'const cp = require("node:child_process"), fs = require("node:fs"), path = require("node:path");',
    'const args = process.argv.slice(2);',
    `const real = ${JSON.stringify(realGit)};`,
    'const run = (a) => cp.spawnSync(real, a, { stdio: "inherit" }).status ?? 1;',
    'if (args[0] === "worktree" && args[1] === "remove") {',
    '  const target = args[args.length - 1];',
    '  try {',
    '    const gitFile = fs.readFileSync(path.join(target, ".git"), "utf8").trim();',
    '    const admin = path.resolve(target, gitFile.slice("gitdir: ".length));',
    '    const receipt = JSON.parse(fs.readFileSync(path.join(admin, "gru-creation-handoff.json"), "utf8"));',
    '    cp.spawnSync(real, ["worktree", "lock", "--reason", receipt.token, target], { stdio: "ignore" });',
    '  } catch { /* the real git still answers on its own terms */ }',
    '  process.exit(run(args));',
    '}',
    'process.exit(run(args));',
  ].join('\n') + '\n');
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH ?? '';
  vi.stubEnv('PATH', `${root}:${originalPath}`);
  return originalPath;
}

/** Every event payload and the note of one job, as text. */
function jobRecordText(h: Pick<RetainedFixture, 'ledger'>, jobId: string): string {
  return JSON.stringify({ note: h.ledger.getJob(jobId)?.note ?? null, events: h.ledger.listJobEvents(jobId, { limit: 1000 }).map((event) => [event.kind, event.payload]) });
}

/** A job dispatched once whose Git child exited while a descendant holds
 * its pipes; `release` lets the descendant exit. */
async function exitedWithoutClose(h: ReturnType<typeof managerFixture>, jobId: string) {
  const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Original briefing ${jobId}` });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: h.repo.path } });
  h.ledger.setJobStatus(jobId, 'working');
  const signals = directory();
  const pidFile = join(signals, 'holder.pid');
  const releaseFile = join(signals, 'release');
  const restore = committedExitWithoutClose(pidFile, releaseFile);
  await expect(h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId })).rejects.toThrow(/did not close within 1000ms/u);
  vi.stubEnv('PATH', restore);
  h.ledger.setJobStatus(jobId, 'blocked');
  const holder = Number(readFileSync(pidFile, 'utf8'));
  return { holder, release: () => { writeFileSync(releaseFile, ''); } };
}

const settlements = (h: Pick<RetainedFixture, 'ledger'>, jobId: string) => h.ledger.listJobEventsByKinds(jobId, ['job.creation-producer-settled']);

describe('retained-creation continuation custody', () => {
  it('settles an exited Git producer once, only after the holder of its pipes releases them, and the continuation is then admissible', async () => {
    const h = managerFixture('late-close');
    const jobId = 'late-close';
    const { holder, release } = await exitedWithoutClose(h, jobId);
    expect(processGone(holder)).toBe(false);
    expect(settlements(h, jobId)).toHaveLength(0);
    await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId })).rejects.toThrow(/cessation is UNKNOWN/u);
    release();
    await vi.waitFor(() => { expect(processGone(holder)).toBe(true); }, { timeout: 10_000 });
    await vi.waitFor(() => { expect(settlements(h, jobId)).toHaveLength(1); });
    const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId });
    expect(inspection.producerSettlementSeq).toBe(settlements(h, jobId)[0]!.seq);
    const api = await httpHarness({ ...h, job: h.ledger.getJob(jobId)!, inspection });
    expect((await request(api.base, 'POST', { job_id: jobId, request_id: 'late-close' })).status).toBe(202);
    await waitForState(api.base, jobId, 'late-close', 'delivered');
    expect(settlements(h, jobId)).toHaveLength(1);
    expect(api.spawns).toHaveLength(1);
  });

  it('never counts the close its own released pipes cause as producer settlement', async () => {
    const h = managerFixture('released-close', { creationCloseWindowMs: 100 });
    const jobId = 'released-close';
    const { holder, release } = await exitedWithoutClose(h, jobId);
    // A timer due after the 100 ms window: the window has released the pipes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(processGone(holder)).toBe(false);
    release();
    await vi.waitFor(() => { expect(processGone(holder)).toBe(true); }, { timeout: 10_000 });
    expect(settlements(h, jobId)).toHaveLength(0);
    await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId })).rejects.toThrow(/cessation is UNKNOWN/u);
  });

  it('records one settlement per receipt token and refuses the token for another branch', async () => {
    const h = managerFixture('settlement-once');
    const sha = git(h.repo, ['rev-parse', 'HEAD']);
    const tokenSha256 = sha256(`gru-creation:${randomUUID()}`);
    h.ledger.addJob({ id: 'settled-once', repo: basename(h.repo.path), title: 'once', baseBranch: 'main', briefing: 'once' });
    const first = h.ledger.recordCreationProducerSettlement({ jobId: 'settled-once', branch: 'gru/settled-once', sha, tokenSha256, pid: 4242, exitCode: 0, signal: null });
    expect(h.ledger.recordCreationProducerSettlement({ jobId: 'settled-once', branch: 'gru/settled-once', sha, tokenSha256, pid: 4343, exitCode: null, signal: 'SIGKILL' })).toEqual(first);
    h.ledger.addJob({ id: 'other-branch', repo: basename(h.repo.path), title: 'other', baseBranch: 'main', briefing: 'other' });
    expect(() => h.ledger.recordCreationProducerSettlement({ jobId: 'other-branch', branch: 'gru/other-branch', sha, tokenSha256, pid: 4242, exitCode: 0, signal: null }))
      .toThrow(/already settled for job "settled-once"/u);
    expect(settlements(h, 'settled-once')).toHaveLength(1);
    expect(settlements(h, 'other-branch')).toHaveLength(0);
  });

  it('keeps an ordinary dispatch when its producer settlement cannot be recorded, and logs it', async () => {
    const sink = logSink();
    const h = managerFixture('settlement-write-failure', { log: sink.log });
    const jobId = 'settlement-write-failure';
    h.ledger.recordCreationProducerSettlement = () => { throw new Error('synthetic SQLITE_BUSY'); };
    const prompts: string[] = [];
    const dispatch = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => fakeHandle('ordinary-minion', prompts) });
    const outcome = await dispatch.dispatch({ jobId, repoPath: h.repo.path, title: 'ordinary', briefing: 'ordinary briefing' });
    expect(await outcome.settled).toEqual({ ok: true });
    expect(h.ledger.getJob(jobId)?.status).toBe('delivered');
    expect(h.ledger.getWorktree(jobId)).toMatchObject({ status: 'active', branch: `gru/${jobId}` });
    expect(receiptFiles(h.repo)).toHaveLength(0);
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: expect.stringMatching(/producer settlement could not be recorded/u) }));
  });

  it('runs the configured setup in the continuation lane', async () => {
    const h = await retainedFixture('setup-runs', { prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "touch setup-ran.txt"\n', 'fixture setup manifest'); } });
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'setup' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'setup', 'delivered');
    expect(existsSync(join(api.ledger.getWorktree(api.jobId)!.path, 'setup-ran.txt'))).toBe(true);
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['worktree.bootstrapped'])).toHaveLength(1);
  });

  it('rolls the checkout back under its token after a setup failure, keeps the ref and receipt, and a later request adopts them', async () => {
    const flag = join(directory(), 'setup-may-pass');
    const h = await retainedFixture('setup-fails', {
      prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', `[[setup]]\ncommand = "test -e ${flag}"\n`, 'flaky setup manifest'); },
    });
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'setup-fails' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'setup-fails', 'failed');
    expect(failed).toMatchObject({
      active: false, admission: null, delivery: null,
      custody: { worktree_id: null, path: null, branch: `gru/${api.jobId}`, sha: h.inspection.sha, base_source: h.inspection.baseSource, status: 'retained', evidence: 'retained-receipt' },
    });
    expect(failed['reason']).toMatch(/^retained creation of branch gru\/setup-fails failed after adoption; its checkout was rolled back and its ref and receipt are kept: worktree setup command exited 1/u);
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'retained-custody-kept' });
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(h.inspection.sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(existsSync(join(h.root, basename(h.repo.path), `job-${api.jobId}`))).toBe(false);
    expect(git(api.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gmu)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
    expect(api.ledger.getJob(api.jobId)?.status).toBe('blocked');

    writeFileSync(flag, '');
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'setup-passes' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'setup-passes', 'delivered');
    expect(api.ledger.getWorktree(api.jobId)).toMatchObject({ status: 'active', sha: h.inspection.sha });
    expect(receiptFiles(api.repo)).toHaveLength(0);
    expect(api.spawns).toHaveLength(1);
  });

  it('keeps everything and reads custody-unknown when a failed setup leaves a process of any step running', async () => {
    const signals = directory();
    const survivor = (name: string): string => `sh -c 'echo $$ > ${join(signals, name)}; exec sleep 6' >/dev/null 2>&1 &`;
    for (const [name, manifest, reason] of [
      ['timeout', '[[setup]]\ncommand = "(trap \'\' TERM; exec sleep 3) >/dev/null 2>&1 & sleep 30"\n', /worktree setup command timed out after 300ms/u],
      ['nonzero', `[[setup]]\ncommand = "${survivor('nonzero.pid')} sleep 0.3; exit 3"\n`, /worktree setup command exited 3/u],
      ['earlier-step', `[[setup]]\ncommand = "${survivor('earlier-step.pid')} sleep 0.3"\n\n[[setup]]\ncommand = "exit 4"\n`, /worktree setup command exited 4/u],
    ] as const) {
      const h = await retainedFixture(`setup-survivor-${name}`, {
        manager: { setupTimeoutMs: name === 'timeout' ? 300 : 30_000 },
        prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', manifest, `setup leaving a process (${name})`); },
      });
      try {
        const api = await httpHarness(h);
        expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: name })).status, name).toBe(202);
        const unknown = await waitForState(api.base, api.jobId, name, 'custody-unknown');
        expect(unknown['reason'], name).toMatch(reason);
        expect(existsSync(join(h.root, basename(h.repo.path), `job-${api.jobId}`)), name).toBe(true);
        expect(receiptFiles(api.repo), name).toHaveLength(1);
        expect(api.spawns, name).toHaveLength(0);
      } finally {
        if (existsSync(join(signals, `${name}.pid`))) {
          try { process.kill(Number(readFileSync(join(signals, `${name}.pid`), 'utf8'))); } catch { /* already gone */ }
        }
      }
    }
  });

  it('keeps everything and reads custody-unknown when a detached daemon a setup step started still runs in the checkout', async () => {
    const signals = directory();
    const pidFile = join(signals, 'daemon.pid');
    const release = join(signals, 'release');
    const starter = [
      "const { spawn } = require('node:child_process');",
      `spawn('/bin/sh', ['-c', 'echo $$ > "$0"; while [ ! -e "$1" ]; do sleep 0.05; done', ${JSON.stringify(pidFile)}, ${JSON.stringify(release)}], { detached: true, stdio: 'ignore' }).unref();`,
    ].join('\n') + '\n';
    const h = await retainedFixture('setup-daemon', {
      // The real process listing (no stub): the daemon is in its own
      // session, outside every step's group.
      manager: { enumerateProcesses: undefined },
      prepare: (repo) => {
        repo.commitFile('start-daemon.js', starter, 'daemon starter');
        repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "node start-daemon.js"\n\n[[setup]]\ncommand = "exit 4"\n', 'setup with a daemon');
      },
    });
    try {
      const api = await httpHarness(h);
      expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'daemon' })).status).toBe(202);
      const unknown = await waitForState(api.base, api.jobId, 'daemon', 'custody-unknown');
      expect(unknown['reason']).toMatch(/worktree setup command exited 4/u);
      expect(processGone(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
      expect(existsSync(join(h.root, basename(h.repo.path), `job-${api.jobId}`))).toBe(true);
      expect(receiptFiles(api.repo)).toHaveLength(1);
      expect(api.spawns).toHaveLength(0);
    } finally {
      writeFileSync(release, '');
    }

    // A listing that fails cannot clear the checkout either.
    const unlisted = await retainedFixture('setup-unlisted', {
      manager: { enumerateProcesses: () => { throw new Error('synthetic process listing failure'); } },
      prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "exit 4"\n', 'failing setup'); },
    });
    const api = await httpHarness(unlisted);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'unlisted' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'unlisted', 'custody-unknown');
    expect(existsSync(join(unlisted.root, basename(unlisted.repo.path), `job-${api.jobId}`))).toBe(true);
  });

  it('keeps everything and reads custody-unknown when the listing cannot read the working directories of a daemon tied only by its cwd', async () => {
    const signals = directory();
    const pidFile = join(signals, 'daemon.pid');
    const release = join(signals, 'release');
    const starter = [
      "const { spawn } = require('node:child_process');",
      `spawn('/bin/sh', ['-c', 'echo $$ > "$0"; while [ ! -e "$1" ]; do sleep 0.05; done', ${JSON.stringify(pidFile)}, ${JSON.stringify(release)}], { detached: true, stdio: 'ignore' }).unref();`,
    ].join('\n') + '\n';
    const h = await retainedFixture('setup-daemon-no-cwds', {
      // ps answers; the working-directory listing (lsof, /proc) fails.
      manager: { enumerateProcesses: undefined, listProcessCwds: () => Promise.reject(new Error('lsof: synthetic failure (exit 1)')) },
      prepare: (repo) => {
        repo.commitFile('start-daemon.js', starter, 'daemon starter');
        repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "node start-daemon.js"\n\n[[setup]]\ncommand = "exit 4"\n', 'setup with a daemon');
      },
    });
    try {
      const api = await httpHarness(h);
      expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'no-cwds' })).status).toBe(202);
      await waitForState(api.base, api.jobId, 'no-cwds', 'custody-unknown');
      expect(processGone(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
      expect(existsSync(join(h.root, basename(h.repo.path), `job-${api.jobId}`))).toBe(true);
      expect(receiptFiles(api.repo)).toHaveLength(1);
    } finally {
      writeFileSync(release, '');
    }
  });

  it('reads back refused, with everything retained, when a custody guard refuses after adoption', async () => {
    const h = await retainedFixture('guard-after-adoption');
    const manager = h.worktrees as unknown as { assertCreationIdentity: (...args: unknown[]) => void };
    manager.assertCreationIdentity = () => { throw new Error('worktree creation target changed: synthetic foreign change'); };
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'guard' })).status).toBe(202);
    const refused = await waitForState(api.base, api.jobId, 'guard', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(refused['reason']).toMatch(/worktree creation target changed/u);
    expect(existsSync(join(h.root, basename(h.repo.path), `job-${api.jobId}`))).toBe(true);
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('reads back custody-unknown when the creation fails after registering the lane', async () => {
    const h = await retainedFixture('after-registration');
    (h.worktrees as unknown as { handoffLane: () => void }).handoffLane = () => { throw new Error('worktree creation custody handoff failed (synthetic)'); };
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'after-registration' })).status).toBe(202);
    const unknown = await waitForState(api.base, api.jobId, 'after-registration', 'custody-unknown');
    expect((unknown['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'custody-unknown', stage: 'registered-unsettled' });
    expect(unknown['custody']).toMatchObject({ status: 'active', evidence: 'ledger-registry-only' });
    expect(api.spawns).toHaveLength(0);
  });

  it('disposes the spawned minion, sweeps its lane and reads failed before the prompt when a write after the spawn throws', async () => {
    const h = await retainedFixture('admitted-write');
    const original = h.ledger.recordCreationContinuationState.bind(h.ledger);
    h.ledger.recordCreationContinuationState = (input) => {
      if (input.state === 'admitted') throw new Error('synthetic admitted-state write failure');
      return original(input);
    };
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'admitted-write' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'admitted-write', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-prompt' });
    expect(failed).toMatchObject({ reason: 'synthetic admitted-state write failure', custody: { status: 'swept' }, delivery: null });
    expect(api.spawns).toEqual(['fixture-minion-1']);
    expect(api.disposed).toEqual(['fixture-minion-1']);
    expect(api.prompts).toHaveLength(0);
    expect(api.ledger.getAgent('fixture-minion-1')?.state).toBe('disposed');
    expect(api.ledger.getJob(api.jobId)?.status).toBe('blocked');
    // The known outcome leaves no continuation fence: a later request is
    // judged on the job itself, where registration already spent the receipt.
    const later = await request(api.base, 'POST', { job_id: api.jobId, request_id: 'later' });
    expect((later.body['readback'] as Record<string, unknown>)['reason']).toMatch(/^retained creation receipt for branch gru\/admitted-write is absent/u);
  });

  it('keeps the original post-spawn error, the agent row and the lane when the disposal itself fails', async () => {
    const h = managerFixture('dispose-fails');
    const original = h.ledger.appendCustomEvent.bind(h.ledger);
    h.ledger.appendCustomEvent = ((input: Parameters<typeof original>[0]) => {
      if (input.kind === 'job.minion-spawned') throw new Error('synthetic spawn-event write failure');
      return original(input);
    }) as typeof original;
    const handle = fakeHandle('dispose-fails-minion', []);
    handle.dispose = async () => { throw new Error('synthetic dispose failure'); };
    const dispatch = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => handle });
    const error = await dispatch.dispatch({ jobId: 'dispose-fails', repoPath: h.repo.path, title: 'dispose', briefing: 'dispose briefing' }).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual(['Error: synthetic spawn-event write failure', 'Error: synthetic dispose failure']);
    // The minion may still run: its row is not marked disposed and its lane is not swept.
    expect(h.ledger.getAgent('dispose-fails-minion')?.state).toBe('spawning');
    expect(h.ledger.getWorktree('dispose-fails')?.status).toBe('active');
    expect(h.ledger.getJob('dispose-fails')?.note).toMatch(/^dispatch failed: AggregateError: Error: synthetic spawn-event write failure/u);

    // A continuation reads that back as custody-unknown.
    const retained = await retainedFixture('dispose-fails-continuation');
    const record = retained.ledger.recordCreationContinuationState.bind(retained.ledger);
    retained.ledger.recordCreationContinuationState = (input) => {
      if (input.state === 'admitted') throw new Error('synthetic admitted-state write failure');
      return record(input);
    };
    const api = await httpHarness(retained, { disposeFailure: new Error('synthetic dispose failure') });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'dispose-fails' })).status).toBe(202);
    const unknown = await waitForState(api.base, api.jobId, 'dispose-fails', 'custody-unknown');
    expect(unknown).toMatchObject({ custody: { status: 'active' }, admission: { agent_id: 'fixture-minion-1' } });
    expect(api.ledger.getAgent('fixture-minion-1')?.state).toBe('spawning');
  });

  it('keeps the lane and reads custody-unknown when the minion refused right after its spawn does not dispose', async () => {
    // Ordinary dispatch: the original refusal comes first and the lane stays.
    const h = managerFixture('post-spawn-check');
    const handle = fakeHandle('post-spawn-check-minion', []);
    handle.dispose = async () => { throw new Error('synthetic dispose failure'); };
    const dispatch = new DispatchService({
      ledger: h.ledger, worktrees: h.worktrees,
      spawner: async () => { h.ledger.setJobStatus('post-spawn-check', 'parked'); return handle; },
    });
    const error = await dispatch.dispatch({ jobId: 'post-spawn-check', repoPath: h.repo.path, title: 'parked', briefing: 'parked briefing' }).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual(['Error: initial dispatch refused — job "post-spawn-check" is parked', 'Error: synthetic dispose failure']);
    expect(h.ledger.getWorktree('post-spawn-check')?.status).toBe('active');
    expect(h.ledger.getAgent('post-spawn-check-minion')).toBeNull();

    // A continuation reads it back as custody-unknown.
    const retained = await retainedFixture('post-spawn-check-continuation');
    const api = await httpHarness(retained, {
      disposeFailure: new Error('synthetic dispose failure'),
      afterSpawn: () => { retained.ledger.setJobStatus(retained.job.id, 'parked'); },
    });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'post-spawn-check' })).status).toBe(202);
    const unknown = await waitForState(api.base, api.jobId, 'post-spawn-check', 'custody-unknown');
    expect(unknown).toMatchObject({ custody: { status: 'active' }, admission: null, delivery: null });
    expect(unknown['reason']).toMatch(/is parked; disposing the spawned minion also failed: Error: synthetic dispose failure/u);
    expect(api.spawns).toEqual(['fixture-minion-1']);
    expect(api.prompts).toHaveLength(0);
  });

  it('settles the job delivered when only the continuation delivered-state write fails', async () => {
    const h = await retainedFixture('delivered-write');
    const original = h.ledger.recordCreationContinuationState.bind(h.ledger);
    h.ledger.recordCreationContinuationState = (input) => {
      if (input.state === 'delivered') throw new Error('synthetic delivered-state write failure');
      return original(input);
    };
    const sink = logSink();
    const api = await httpHarness(h, { service: { log: sink.log } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'delivered-write' })).status).toBe(202);
    await vi.waitFor(() => { expect(api.ledger.getJob(api.jobId)?.status).toBe('delivered'); }, { timeout: 10_000 });
    const readback = await waitForState(api.base, api.jobId, 'delivered-write', 'delivered');
    expect(readback).toMatchObject({ active: false, delivery: { agent_id: 'fixture-minion-1' } });
    expect(api.ledger.getCreationContinuation(api.jobId, 'delivered-write')?.state).toBe('admitted');
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: expect.stringMatching(/delivered state could not be recorded/u) }));
  });

  it('never writes a creation token into a job note or event when the checkout cannot be added', async () => {
    const h = await retainedFixture('token-worktree-add');
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      const sink = logSink();
      const api = await httpHarness(h, { serverLog: sink.log });
      expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'token-worktree-add' })).status).toBe(202);
      const failed = await waitForState(api.base, api.jobId, 'token-worktree-add', 'failed');
      expect(failed['reason']).toMatch(/<redacted-creation-token>/u);
      expect(api.ledger.getJob(api.jobId)?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
      expect(hasRawCreationToken(jobRecordText(api, api.jobId))).toBe(false);

      // Ordinary dispatch redacts it the same way: the HTTP detail, the
      // handler's log line and the job note.
      const response = await fetch(`${api.base}/api/dispatch`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ job_id: 'token-ordinary', repo_path: h.repo.path, title: 'ordinary', briefing: 'ordinary briefing' }),
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(400);
      expect(body['detail']).toMatch(/git worktree add --lock --reason <redacted-creation-token>/u);
      expect(sink.entries.filter((entry) => entry.msg === 'dispatch api handler failed')).toHaveLength(1);
      expect(hasRawCreationToken(JSON.stringify({ body, logs: sink.entries }))).toBe(false);
      expect(h.ledger.getJob('token-ordinary')?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
      expect(hasRawCreationToken(jobRecordText(h, 'token-ordinary'))).toBe(false);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('never writes a creation token into a job note or event when a foreign administration appears after inspection', async () => {
    const h = await retainedFixture('token-foreign-admin');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'token-foreign-admin' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'token-foreign-admin', 'queued');
    const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    const admin = join(common, 'worktrees', 'forged');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(realpathSync(parent), `job-${api.jobId}`, '.git')}\n`);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/gru/${api.jobId}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'locked'), `gru-creation:${randomUUID()}\n`);
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'token-foreign-admin', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(api.ledger.getJob(api.jobId)?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
    expect(hasRawCreationToken(jobRecordText(api, api.jobId))).toBe(false);
    expect(api.spawns).toHaveLength(0);
  });

  it('redacts the creation token from the rollback rethrow and its inner errors', async () => {
    // The failed `git worktree add --lock --reason gru-creation:<token>` and
    // the rollback that cannot prove an invocation-owned reservation are two
    // different errors; both leave through the rethrow, and neither may carry
    // the custody token.
    const h = managerFixture('rollback-rethrow-redaction');
    const jobId = 'rollback-rethrow-redaction';
    h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Briefing ${jobId}` });
    h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: basename(h.repo.path), repoPath: h.repo.path } });
    h.ledger.setJobStatus(jobId, 'working');
    // An unwritable lane root fails the checkout add before any path or
    // orphan administration exists, so the rollback has no owned holder.
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      const thrown = await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId }).then(() => null, (failure: unknown) => failure);
      // The rethrow ran: the failed add and the failed rollback are paired.
      expect(thrown).toBeInstanceOf(AggregateError);
      const rethrown = thrown as AggregateError;
      expect(rethrown.errors).toHaveLength(2);
      expect(String(rethrown.errors[0])).toMatch(/^Error: git worktree add --lock --reason /u);
      expect(String(rethrown.errors[1])).toMatch(/has no invocation-owned checkout reservation$/u);
      expect(rethrown.message).toMatch(/^worktree creation failed \(Error: git worktree add --lock --reason /u);

      // The exact token this creation minted: its durable receipt survives the
      // failed rollback, so the assertion is bound to the real secret.
      const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const token = readCreationIntent(common, `gru/${jobId}`)?.token;
      expect(token).toMatch(/^gru-creation:[0-9a-f]{8}-/u);
      expect(receiptFiles(h.repo)).toHaveLength(1);

      const text = JSON.stringify({
        message: rethrown.message,
        stack: rethrown.stack,
        inner: rethrown.errors.map((error: Error) => [error.name, error.message, error.stack]),
      });
      expect(hasRawCreationToken(text)).toBe(false);
      expect(text).not.toContain(token!);

      // The operator meaning survives: the path, the custody condition and
      // what to inspect, with only the secret replaced.
      const path = join(parent, `job-${jobId}`);
      expect(rethrown.message).toContain('<redacted-creation-token>');
      expect(rethrown.message).toContain(`rollback custody unconfirmed for ${path}`);
      expect(rethrown.message).toContain('inspect retained resources before retry');
      expect(String(rethrown.errors[0])).toContain('<redacted-creation-token>');
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('redacts the creation token from the rollback log line that refuses an orphan administration', async () => {
    // The rollback's own orphanCreationAdmin refusal names the custody token
    // it expected; the manager log line that records it must not.
    const sink = logSink();
    const h = managerFixture('rollback-log-redaction', { log: sink.log });
    const jobId = 'rollback-log-redaction';
    h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Briefing ${jobId}` });
    h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: basename(h.repo.path), repoPath: h.repo.path } });
    h.ledger.setJobStatus(jobId, 'working');
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    const path = join(parent, `job-${jobId}`);
    const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    // An administration that claims this lane's path under another creation's
    // lock: the rollback meets it and refuses by name.
    const admin = join(common, 'worktrees', 'foreign');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(realpathSync(parent), `job-${jobId}`, '.git')}\n`);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/gru/${jobId}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'locked'), `gru-creation:${randomUUID()}\n`);
    chmodSync(parent, 0o555);
    try {
      const thrown = await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId }).then(() => null, (failure: unknown) => failure);
      expect(thrown).toBeInstanceOf(AggregateError);
      const token = readCreationIntent(common, `gru/${jobId}`)?.token;
      expect(token).toMatch(/^gru-creation:[0-9a-f]{8}-/u);

      const refusal = sink.entries.find((entry) => entry.msg === 'creation rollback custody unconfirmed; resources retained');
      expect(refusal, 'the rollback custody log line was emitted').toBeDefined();
      expect(refusal!.level).toBe('error');
      expect(refusal!.fields['path']).toBe(path);
      const detail = String(refusal!.fields['error']);
      expect(detail).toContain('lane administration');
      expect(detail).toContain('is locked for another creation');
      expect(detail).toContain('inspect it before retrying');
      expect(detail).toContain('<redacted-creation-token>');
      expect(detail).not.toContain(token!);
      expect(hasRawCreationToken(JSON.stringify(sink.entries))).toBe(false);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('redacts the token from the creation error a successful rollback rethrows', async () => {
    // A branchless review lane has nothing to remove, so its rollback returns
    // normally and the caller rethrows the failed `git worktree add` itself —
    // the post-rollback surface, not the rollback catch.
    const sink = logSink();
    const h = managerFixture('review-rethrow-redaction', { log: sink.log });
    // A review lane resolves its ref from a freshly fetched origin, never a
    // stale local tip: give the fixture the bare origin the other suites use.
    attachBareOrigin(h.repo);
    git(h.repo, ['push', 'origin', 'main']);
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      const thrown = await h.worktrees.createReviewWorktree({ repoPath: h.repo.path, roundId: 'round-redaction', ref: 'origin/main' })
        .then(() => null, (failure: unknown) => failure);
      // The rollback succeeded: the catch that logs and rethrows never ran.
      expect(sink.entries.filter((entry) => entry.msg === 'creation rollback custody unconfirmed; resources retained')).toHaveLength(0);
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toMatch(/^git worktree add --lock --reason /u);
      expect(error.message).toContain('<redacted-creation-token>');
      expect(hasRawCreationToken(JSON.stringify([error.message, error.stack, String(error)]))).toBe(false);
      // The operator meaning survives: the failed command and the lane path.
      expect(error.message).toContain(join(parent, 'review-round-redaction'));
      expect(error.message).toContain('failed (exit');
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('redacts the live receipt token when reconciliation refuses a foreign administration', async () => {
    // reconcileInterruptedCreation queries the orphan administration directly,
    // outside the rollback catch; its refusal names the receipt token, which is
    // still LIVE because a retained receipt is deliberately kept.
    const h = managerFixture('reconcile-redaction');
    const jobId = 'reconcile-redaction';
    const retained = syntheticRetained(h, jobId);
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const admin = join(common, 'worktrees', 'foreign');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(realpathSync(parent), `job-${jobId}`, '.git')}\n`);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${retained.branch}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'locked'), `gru-creation:${randomUUID()}\n`);
    const thrown = await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId }).then(() => null, (failure: unknown) => failure);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toContain('lane administration');
    expect(error.message).toContain('is locked for another creation');
    expect(error.message).toContain('inspect it before retrying');
    expect(error.message).toContain('<redacted-creation-token>');
    expect(error.message).not.toContain(retained.token);
    const cause = error.cause instanceof Error ? error.cause : null;
    expect(JSON.stringify({
      message: error.message,
      stack: error.stack,
      cause: cause === null ? null : [cause.message, cause.stack],
    })).not.toMatch(/gru-creation:[0-9a-f]{8}-/u);
  });

  it('redacts the token an external lock makes the disk-budget removal echo', async () => {
    // The disk-budget release removes off the event loop (runGitAsync) with a
    // single --force. An actor that locks the lane after the release's custody
    // proof but before git's own removal makes git refuse and echo the lock
    // reason — the creation token — into the release failure and its record.
    const sink = logSink();
    const h = managerFixture('locked-release-redaction', { log: sink.log });
    const jobId = 'locked-release-redaction';
    h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Briefing ${jobId}` });
    h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: basename(h.repo.path), repoPath: h.repo.path } });
    h.ledger.setJobStatus(jobId, 'working');
    const record = await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId });
    // The lane's own custody token, read from its completed handoff receipt.
    const gitFile = readFileSync(join(record.path, '.git'), 'utf8').trim();
    const admin = resolve(record.path, gitFile.slice('gitdir: '.length));
    const token = (JSON.parse(readFileSync(join(admin, 'gru-creation-handoff.json'), 'utf8')) as { readonly token: string }).token;
    expect(token).toMatch(/^gru-creation:[0-9a-f]{8}-/u);
    const restore = lockBeforeRemovalGit();
    try {
      const thrown = await h.worktrees.release({ worktreeId: jobId, requireReleaseProofs: true, onLiveProcess: 'refuse', diskBudget: true })
        .then(() => null, (failure: unknown) => failure);
      // The async removal ran and its refusal was recorded, not silently dropped.
      const aborted = h.ledger.listJobEventsByKinds(jobId, ['worktree.release-aborted']);
      expect(aborted, `release rejected with: ${thrown instanceof Error ? thrown.message : String(thrown)}`).toHaveLength(1);
      const detail = String((aborted[0]!.payload as Record<string, unknown>)['error']);
      expect(detail).toContain('cannot remove a locked working tree');
      expect(detail).toContain('<redacted-creation-token>');
      expect(detail).not.toContain(token);
      const error = thrown as Error;
      expect(error.message).not.toContain(token);
      expect(hasRawCreationToken(JSON.stringify([error.message, error.stack, sink.entries]))).toBe(false);
      expect(sink.entries.some((entry) => entry.msg === 'release aborted after its records; the tree is retained and a retry reuses what was saved')).toBe(true);
    } finally {
      vi.stubEnv('PATH', restore);
    }
  });

  it('redacts the token a failing setup command prints from the lane registry', async () => {
    // While a lane is still locked for its creation, `git worktree list
    // --porcelain` prints its lock reason. A setup command that prints it and
    // fails carries the token into the setup error, which records durably.
    const h = managerFixture('setup-registry-redaction');
    const jobId = 'setup-registry-redaction';
    h.repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "git worktree list --porcelain; exit 3"\n', 'setup that prints the lane registry');
    const retained = syntheticRetained(h, jobId);
    const thrown = await h.worktrees.createRetainedJobWorktree({
      repoPath: h.repo.path, jobId,
      expected: { receiptTokenSha256: sha256(retained.token), producerSettlementSeq: settlements(h, jobId)[0]!.seq },
    }).then(() => null, (failure: unknown) => failure);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toContain('worktree setup command exited 3');
    // The continuation kept its receipt, so the exact token is still readable.
    const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const token = readCreationIntent(common, retained.branch)?.token;
    expect(token).toBe(retained.token);
    expect(error.message).toContain('<redacted-creation-token>');
    expect(error.message).not.toContain(retained.token);
    const cause = error.cause instanceof Error ? error.cause : null;
    expect(hasRawCreationToken(JSON.stringify({
      message: error.message,
      stack: error.stack,
      cause: cause === null ? null : [cause.message, cause.stack, (cause as unknown as { output?: unknown }).output],
    }))).toBe(false);
  });

  it('reads back custody-unknown when shutdown cancels the automatic retries after the prompt was sent', async () => {
    const h = await retainedFixture('shutdown-cancel');
    const stop = new AbortController();
    const api = await httpHarness(h, { service: { stopSignal: stop.signal, retrySettlement: () => { stop.abort(); return new Promise(() => {}); } } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'shutdown-cancel' })).status).toBe(202);
    const unknown = await waitForState(api.base, api.jobId, 'shutdown-cancel', 'custody-unknown');
    expect(api.prompts).toHaveLength(1);
    expect(unknown).toMatchObject({ active: false, admission: { agent_id: 'fixture-minion-1' }, delivery: null });
    expect((unknown['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'custody-unknown', stage: 'turn-outcome-unknown' });
  });

  it('reads back custody-unknown for a turn that fails, rejected or in-band, while the service is stopping', async () => {
    for (const ending of ['rejected', 'in-band'] as const) {
      const h = await retainedFixture(`shutdown-${ending}`);
      const stop = new AbortController();
      const api = await httpHarness(h, {
        // Shutdown, then the registry's disposal ends the running turn.
        prompt: async () => { stop.abort(); if (ending === 'rejected') throw new Error('session disposed: service shutting down'); },
        health: () => ({ state: 'error', error: 'session disposed: service shutting down', lastActivity: null, sessionFile: null }),
        service: { stopSignal: stop.signal, retrySettlement: async () => 'none' },
      });
      expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: ending })).status, ending).toBe(202);
      const unknown = await waitForState(api.base, api.jobId, ending, 'custody-unknown');
      expect((unknown['timeline'] as readonly Record<string, unknown>[]).at(-1), ending).toMatchObject({ state: 'custody-unknown', stage: 'turn-outcome-unknown' });
      expect(unknown['reason'], ending).toMatch(/session disposed: service shutting down/u);
      expect(api.prompts, ending).toHaveLength(1);
    }
  });

  it('takes the job admission after the disk floor, so the owner can stop and bin a continuation queued there', async () => {
    const h = await retainedFixture('stop-at-floor');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'stop-at-floor' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'stop-at-floor', 'queued');
    api.ledger.setJobStatus(api.jobId, 'parked');
    const stop = new JobExecutionStop({ ledger: api.ledger, handles: { list: () => [] }, children: null, reviews: null, log: () => {} });
    const outcome = await stop.stop({ jobId: api.jobId, by: 'fixture-owner', reason: 'stop the queued continuation' });
    expect(outcome).toMatchObject({ state: 'stopped', outstanding: [] });
    api.ledger.setJobStatus(api.jobId, 'binned');
    held.release();
    const failed = await waitForState(api.base, api.jobId, 'stop-at-floor', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-manager' });
    expect(api.ledger.getJob(api.jobId)?.status).toBe('binned');
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(h.inspection.sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses by name a directive that started while the continuation waited at the floor', async () => {
    const h = await retainedFixture('directive-at-floor');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'directive-at-floor' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'directive-at-floor', 'queued');
    const directive = api.ledger.beginDirectiveIntent({ jobId: api.jobId, directive: 'fixture directive', holder: 'silas-ops' }).record;
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'directive-at-floor', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'admission-refused' });
    expect(refused['reason']).toBe(`job "${api.jobId}" has a live directive request (${directive.requestId}, dispatching) that owns the lane`);
    expect(api.ledger.listJobAdmissions(api.jobId)).toEqual([]);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a live property admission taken while queued at the floor as admission-refused', async () => {
    const h = await retainedFixture('admission-refused');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'admission-refused' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'admission-refused', 'queued');
    const releaseProperty = api.ledger.beginJobAdmission(api.jobId, 'property repair fixture');
    try {
      held.release();
      const refused = await waitForState(api.base, api.jobId, 'admission-refused', 'refused');
      expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'admission-refused' });
      expect(refused['reason']).toMatch(/competing property\/producer admission/u);
    } finally {
      releaseProperty();
    }
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a receipt swapped after acceptance even when it carries its own settlement', async () => {
    const h = await retainedFixture('swapped-receipt');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'swapped-receipt' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'swapped-receipt', 'queued');
    const common = git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const original = readCreationIntent(common, h.inspection.branch)!;
    const token = `gru-creation:${randomUUID()}`;
    clearCreationIntent(common, h.inspection.branch, original.token);
    writeCreationIntent(common, { lane: original.lane, repoPath: original.repoPath, branch: original.branch, sha: original.sha, baseSource: original.baseSource, token });
    const ref = `refs/heads/${h.inspection.branch}`;
    git(h.repo, ['update-ref', '-m', 'fixture swap', ref, h.repo.commitFile('swap.txt', 'swap\n', 'fixture swap')]);
    git(h.repo, ['update-ref', '-m', token, ref, h.inspection.sha]);
    h.ledger.recordCreationProducerSettlement({ jobId: api.jobId, branch: h.inspection.branch, sha: h.inspection.sha, tokenSha256: sha256(token), pid: 4242, exitCode: 0, signal: null });
    // The swapped receipt is otherwise a valid retained creation.
    expect((await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId: api.jobId })).receiptTokenSha256).toBe(sha256(token));
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'swapped-receipt', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(refused['reason']).toMatch(/is not the receipt this continuation accepted/u);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('continues a job dispatched through a symlinked repository path, and the ledger ties the path to its realpath', async () => {
    const h = managerFixture('symlinked-repository');
    const alias = join(directory(), 'linked-checkout');
    symlinkSync(h.repo.path, alias);
    const jobId = 'symlinked-repository';
    // Ordinary dispatch through the alias records its leaf as the job's repository.
    const original = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => fakeHandle('never-spawned', []) });
    const restore = committedStall();
    await expect(original.dispatch({ jobId, repoPath: alias, title: 'alias', briefing: 'Original briefing alias' })).rejects.toThrow(/did not close within 1000ms/u);
    vi.stubEnv('PATH', restore);
    const job = h.ledger.getJob(jobId)!;
    expect(job).toMatchObject({ status: 'blocked', repo: 'linked-checkout' });
    const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: alias, jobId });
    const canonical = realpathSync(h.repo.path);

    // The ledger refuses a path whose leaf matches but that resolves elsewhere.
    const handoff = h.ledger.listJobEventsByKinds(jobId, ['job.handoff'])[0]!;
    const elsewhere = join(directory(), 'linked-checkout');
    const direct = h.ledger.acceptCreationContinuation({
      jobId, requestId: 'elsewhere', payloadSha256: sha256('elsewhere'), handoffSeq: handoff.seq, briefingSha256: sha256(job.briefing!),
      handoffRepoPath: alias, repoPath: elsewhere, branch: inspection.branch, baseSha: inspection.sha, baseSource: inspection.baseSource,
      producerSettlementSeq: inspection.producerSettlementSeq, receiptTokenSha256: inspection.receiptTokenSha256,
    });
    expect(direct.timeline.state).toBe('refused');
    expect((direct.timeline.events[0]!.payload as Record<string, unknown>)['reason']).toBe(
      `job "${jobId}" handoff path ${alias} resolves to ${canonical}, not the inspected repository ${elsewhere}`);

    const api = await httpHarness({ ...h, job, inspection });
    expect((await request(api.base, 'POST', { job_id: jobId, request_id: 'alias' })).status).toBe(202);
    const delivered = await waitForState(api.base, jobId, 'alias', 'delivered');
    expect(delivered['original']).toMatchObject({ handoff_repo_path: alias, repo_path: canonical });
    expect(api.prompts[0]).toContain('Repo: linked-checkout');
    expect(api.ledger.getWorktree(jobId)).toMatchObject({ repoPath: canonical, sha: inspection.sha });
  });

  it('carries the route\'s job-level refusals into the ledger', async () => {
    const h = managerFixture('ledger-job-scope');
    for (const [guard, change, reason] of [
      ['target-ref', 'UPDATE jobs SET target_ref = \'refs/heads/fixture\' WHERE id = ?', /report or pull-request state/u],
      ['target-sha', 'UPDATE jobs SET target_sha = \'0123456789012345678901234567890123456789\' WHERE id = ?', /report or pull-request state/u],
      ['blank-briefing', 'UPDATE jobs SET briefing = \'   \' WHERE id = ?', /no original briefing to reuse/u],
    ] as const) {
      const jobId = `ledger-job-scope-${guard}`;
      const retained = syntheticRetained(h, jobId);
      // A legacy row may carry what the route never writes.
      h.db.handle.prepare(change).run(jobId);
      const job = h.ledger.getJob(jobId)!;
      const accepted = h.ledger.acceptCreationContinuation({
        jobId, requestId: guard, payloadSha256: sha256(guard), handoffSeq: h.ledger.listJobEventsByKinds(jobId, ['job.handoff'])[0]!.seq,
        briefingSha256: sha256(job.briefing!), handoffRepoPath: h.repo.path, repoPath: realpathSync(h.repo.path), branch: retained.branch,
        baseSha: retained.sha, baseSource: 'local-head-fallback', producerSettlementSeq: settlements(h, jobId)[0]!.seq, receiptTokenSha256: sha256(retained.token),
      });
      expect(accepted.timeline.state, guard).toBe('refused');
      expect((accepted.timeline.events[0]!.payload as Record<string, unknown>)['reason'], guard).toMatch(reason);
    }
  });

  it('reads failed before the manager when the repository is gone at the floor, and a later request proceeds once it is back', async () => {
    const h = await retainedFixture('repo-moved-at-floor');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'moved' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'moved', 'queued');
    const moved = `${h.repo.path}-moved`;
    renameSync(h.repo.path, moved);
    held.release();
    const failed = await waitForState(api.base, api.jobId, 'moved', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-manager' });
    expect(failed['reason']).toMatch(/ENOENT/u);
    renameSync(moved, h.repo.path);
    expect(api.ledger.getJob(api.jobId)?.status).toBe('blocked');
    const later = await httpHarness(h);
    expect((await request(later.base, 'POST', { job_id: api.jobId, request_id: 'restored' })).status).toBe(202);
    await waitForState(later.base, api.jobId, 'restored', 'delivered');
    expect(later.spawns).toHaveLength(1);
  });

  it('reads failed before the manager when the handoff symlink is gone at the floor, and a later request proceeds once it is back', async () => {
    const h = managerFixture('symlink-gone-at-floor');
    const alias = join(directory(), 'linked-checkout');
    symlinkSync(h.repo.path, alias);
    const jobId = 'symlink-gone-at-floor';
    const original = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => fakeHandle('never-spawned', []) });
    const restore = committedStall();
    await expect(original.dispatch({ jobId, repoPath: alias, title: 'alias', briefing: 'Original briefing alias' })).rejects.toThrow(/did not close within 1000ms/u);
    vi.stubEnv('PATH', restore);
    const job = h.ledger.getJob(jobId)!;
    const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: alias, jobId });
    const held = heldFloor();
    const api = await httpHarness({ ...h, job, inspection }, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: jobId, request_id: 'gone' })).status).toBe(202);
    await waitForState(api.base, jobId, 'gone', 'queued');
    rmSync(alias);
    held.release();
    const failed = await waitForState(api.base, jobId, 'gone', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-manager' });
    symlinkSync(h.repo.path, alias);
    const later = await httpHarness({ ...h, job, inspection });
    expect((await request(later.base, 'POST', { job_id: jobId, request_id: 'back' })).status).toBe(202);
    await waitForState(later.base, jobId, 'back', 'delivered');
  });

  it('sweeps the lane and reads failed before the prompt when the last pre-prompt check disposes the minion', async () => {
    const h = await retainedFixture('last-check');
    // The owner parks the job between the admission record and the prompt.
    const record = h.ledger.recordCreationContinuationState.bind(h.ledger);
    h.ledger.recordCreationContinuationState = (input) => {
      const timeline = record(input);
      if (input.state === 'admitted') h.ledger.setJobStatus(h.job.id, 'parked');
      return timeline;
    };
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'last-check' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'last-check', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-prompt' });
    expect(failed).toMatchObject({ custody: { status: 'swept' }, delivery: null, reason: expect.stringMatching(/is parked/u) });
    expect(api.prompts).toHaveLength(0);
    expect(api.disposed).toEqual(['fixture-minion-1']);
    expect(api.ledger.getAgent('fixture-minion-1')?.state).toBe('disposed');
    expect(api.ledger.getJob(api.jobId)?.status).toBe('parked');
  });

  it('starts one owner for concurrent identical requests (a client timeout retry)', async () => {
    const h = await retainedFixture('in-flight-duplicate');
    // Both requests pass the pre-acceptance readback before either inspects.
    const inspect = h.worktrees.inspectRetainedJobCreation.bind(h.worktrees);
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((resolve) => { open = resolve; });
    h.worktrees.inspectRetainedJobCreation = async (input) => { arrived += 1; if (arrived === 2) open(); await both; return inspect(input); };
    const api = await httpHarness(h);
    const body = { job_id: api.jobId, request_id: 'duplicate' };
    const outcomes = await Promise.all([request(api.base, 'POST', body), request(api.base, 'POST', body)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 202]);
    await waitForState(api.base, api.jobId, 'duplicate', 'delivered');
    await vi.waitFor(() => { expect(api.dispatch.getCreationContinuationReadback(api.jobId, 'duplicate')?.active).toBe(false); });
    expect(api.ledger.getJob(api.jobId)?.status).toBe('delivered');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
  });

  it('reads back a live admitted turn whose prompt is still running as admitted, active and undelivered', async () => {
    const h = await retainedFixture('live-admitted');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const api = await httpHarness(h, { prompt: () => held });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'live-admitted' })).status).toBe(202);
    await vi.waitFor(() => { expect(api.prompts).toHaveLength(1); }, { timeout: 10_000 });
    const live = (await request(api.base, 'GET', { job_id: api.jobId, request_id: 'live-admitted' })).body['readback'];
    expect(live).toMatchObject({ state: 'admitted', active: true, delivery: null, admission: { agent_id: 'fixture-minion-1' } });
    release();
    await waitForState(api.base, api.jobId, 'live-admitted', 'delivered');
  });

  it('refuses through the dispatch path, with no fresh base, when the retained ref is lost while queued', async () => {
    const h = await retainedFixture('no-fresh-dispatch');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'no-fresh' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'no-fresh', 'queued');
    git(api.repo, ['update-ref', '-d', `refs/heads/gru/${api.jobId}`]);
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'no-fresh', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(git(api.repo, ['branch', '--list', `gru/${api.jobId}`])).toBe('');
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('never accepts a producer settlement bound to another receipt token', async () => {
    const h = managerFixture('token-binding');
    const retained = syntheticRetained(h, 'token-binding', { settle: false });
    // An earlier, different attempt's settlement on the same branch and base.
    h.ledger.recordCreationProducerSettlement({ jobId: 'token-binding', branch: retained.branch, sha: retained.sha, tokenSha256: sha256(`gru-creation:${randomUUID()}`), pid: 4242, exitCode: 0, signal: null });
    const api = await httpHarness({ ...h, job: retained.job });
    const response = await request(api.base, 'POST', { job_id: 'token-binding', request_id: 'token-binding' });
    expect(response.status).toBe(409);
    expect((response.body['readback'] as Record<string, unknown>)['reason']).toMatch(/cessation is UNKNOWN/u);
    const settled = settlements(h, 'token-binding')[0]!;
    const direct = h.ledger.acceptCreationContinuation({
      jobId: 'token-binding', requestId: 'direct', payloadSha256: sha256('direct'),
      handoffSeq: h.ledger.listJobEventsByKinds('token-binding', ['job.handoff'])[0]!.seq, briefingSha256: sha256(retained.job.briefing!),
      handoffRepoPath: h.repo.path, repoPath: realpathSync(h.repo.path), branch: retained.branch, baseSha: retained.sha,
      baseSource: 'local-head-fallback', producerSettlementSeq: settled.seq, receiptTokenSha256: sha256(retained.token),
    });
    expect(direct.timeline).toMatchObject({ state: 'refused' });
    expect((direct.timeline.events[0]!.payload as Record<string, unknown>)['reason']).toMatch(/no exact positive retained-creation producer settlement/u);
    expect(api.ledger.getWorktree('token-binding')).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a new request while an earlier one is custody-unknown', async () => {
    const h = await retainedFixture('unknown-fence');
    const first = acceptDirectly(h, 'first');
    h.ledger.recordCreationContinuationState({ jobId: h.job.id, requestId: 'first', generation: first.timeline.identity.generation, state: 'custody-unknown', stage: 'unsettled-failure', details: { reason: 'fixture' } });
    const api = await httpHarness(h);
    const second = await request(api.base, 'POST', { job_id: api.jobId, request_id: 'second' });
    expect(second.status).toBe(409);
    expect((second.body['readback'] as Record<string, unknown>)['reason']).toMatch(/another continuation request first owns this job's continuation fence/u);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('records a turn that settles failed as a known turn-settled failure', async () => {
    const h = await retainedFixture('turn-failure');
    const api = await httpHarness(h, { prompt: async () => { throw new Error('synthetic turn failure'); } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'turn-failure' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'turn-failure', 'failed');
    expect(failed).toMatchObject({ active: false, admission: { agent_id: 'fixture-minion-1' }, delivery: null, reason: expect.stringMatching(/synthetic turn failure/u) });
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'turn-settled-failure' });
    expect(api.prompts).toHaveLength(1);
  });
});
