import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingMode } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, MachineDispositionRefusedError, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { ownerAttentionFor, requiresTypedDecision } from '../src/notifications/attention.js';
import { onboardingJobId, onboardingKeyOfJob, onboardingRepoKey, renderOnboardingBriefing } from '../src/onboarding/briefing.js';
import { ONBOARDING_CONSENT_FILE, onboardingConsentPath, writeOnboardingConsent } from '../src/onboarding/consent.js';
import { ONBOARDING_EVENTS } from '../src/onboarding/ledger.js';
import type { OriginManifestProbe } from '../src/onboarding/origin-manifest.js';
import { createOnboardingServer } from '../src/onboarding/server.js';
import {
  ONBOARDING_DISPATCH_FAILED_KIND,
  ONBOARDING_DISPATCHED_KIND,
  ONBOARDING_PROPOSAL_KIND,
  ONBOARDING_RECONCILE_INTERVAL_MS,
  OnboardingRefusal,
  OnboardingService,
  type OnboardingDispatchInput,
} from '../src/onboarding/service.js';

/**
 * Onboarding heists (#427): scan, cards, decisions, consent and dispatch.
 * Real git repositories with real bare origins, a real ledger and a real
 * NotificationCenter. Only the dispatch path is a stand-in: it records the
 * heist and creates its job row, as the dispatch service's first step does.
 */

const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Repo {
  readonly path: string;
  readonly origin: string;
  /** Push a manifest to origin's default branch (a merged onboarding PR). */
  mergeManifest(): void;
}

interface Harness {
  readonly root: string;
  readonly instanceDir: string;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly dispatched: OnboardingDispatchInput[];
  readonly logs: { level: string; msg: string; fields: Record<string, unknown> }[];
  /** When set, the stand-in dispatch throws this before any job exists. */
  failDispatch: string | null;
  /** When set, the stand-in dispatch records the job, then throws this (the job ends up blocked). */
  failAfterJob: string | null;
  repo(name: string, opts?: { readonly manifest?: boolean }): Repo;
  service(opts?: {
    readonly mode?: OnboardingMode;
    readonly managed?: readonly string[];
    readonly probe?: (repoPath: string, opts: { readonly signal: AbortSignal }) => Promise<OriginManifestProbe>;
    readonly setInterval?: typeof setInterval;
  }): OnboardingService;
  rows(kind: string): readonly NotificationRecord[];
  events(kind: string): readonly Record<string, unknown>[];
}

function harness(): Harness {
  const root = tempDir('gru-onboarding-ws-');
  const origins = tempDir('gru-onboarding-origins-');
  const instanceDir = tempDir('gru-onboarding-instance-');
  const db = new LedgerDb(tempDir('gru-onboarding-ledger-'));
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const managed: string[] = [];
  const services: OnboardingService[] = [];
  cleanups.push(() => { for (const service of services) service.stop(); });
  const h: Harness = {
    root, instanceDir, ledger, bus, notifications,
    dispatched: [],
    logs: [],
    failDispatch: null,
    failAfterJob: null,
    repo(name, opts = {}) {
      const path = join(root, name);
      mkdirSync(path);
      git(path, 'init', '-q', '-b', 'main');
      writeFileSync(join(path, 'README.md'), `# ${name}\n`);
      if (opts.manifest === true) {
        mkdirSync(join(path, '.gru-command'));
        writeFileSync(join(path, '.gru-command', 'worktree.toml'), '[verify]\nfull = "./check"\n');
      }
      git(path, 'add', '-A');
      git(path, 'commit', '-qm', 'seed');
      const origin = join(origins, `${name}.git`);
      git(origins, 'init', '-q', '--bare', '-b', 'main', origin);
      git(path, 'remote', 'add', 'origin', origin);
      git(path, 'push', '-q', 'origin', 'main');
      managed.push(name);
      return {
        path,
        origin,
        mergeManifest() {
          const clone = join(tempDir('gru-onboarding-clone-'), name);
          git(origins, 'clone', '-q', origin, clone);
          mkdirSync(join(clone, '.gru-command'));
          writeFileSync(join(clone, '.gru-command', 'worktree.toml'), '[verify]\nfull = "./check"\n');
          git(clone, 'add', '-A');
          git(clone, 'commit', '-qm', 'Onboard to GC');
          git(clone, 'push', '-q', 'origin', 'main');
        },
      };
    },
    service(opts = {}) {
      const service = new OnboardingService({
        onboarding: { mode: opts.mode ?? 'proposed' },
        workspaceRoot: root,
        managedRepos: opts.managed ?? [...managed],
        instanceDir,
        ledger,
        bus,
        notifications,
        dispatch: async (input) => {
          if (h.failDispatch !== null) throw new Error(h.failDispatch);
          h.dispatched.push(input);
          ledger.addJob({ id: input.jobId, repo: basename(input.repoPath), title: input.title, briefing: input.briefing });
          if (h.failAfterJob !== null) throw new Error(h.failAfterJob);
        },
        ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
        ...(opts.setInterval !== undefined ? { setInterval: opts.setInterval } : {}),
        log: (level, msg, fields) => h.logs.push({ level, msg, fields: fields ?? {} }),
      });
      services.push(service);
      return service;
    },
    rows(kind) {
      return ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === kind);
    },
    events(kind) {
      return ledger.listEventsAfter(0, { kinds: [kind], limit: 500 }).map((event) => event.payload as Record<string, unknown>);
    },
  };
  return h;
}

async function started(service: OnboardingService): Promise<OnboardingService> {
  service.start();
  await service.idle();
  return service;
}

async function decide(h: Harness, service: OnboardingService, id: string, option: 'accept' | 'decline'): Promise<void> {
  h.notifications.decide(id, option, 'owner');
  await service.idle();
}

describe('onboarding scan and cards (#427)', () => {
  it('Missing: one "Onboard swift-app" card; Accept dispatches the heist through the normal path and closes the card', async () => {
    const h = harness();
    const repo = h.repo('swift-app');
    const service = await started(h.service());
    const cards = h.rows(ONBOARDING_PROPOSAL_KIND);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ title: 'Onboard swift-app', routing: 'needs-owner', resolvedAt: null });
    expect(card.detail).toContain('origin/main');
    expect(card.decision?.options.map((option) => option.id)).toEqual(['accept', 'decline']);
    expect(card.decision?.reservedClass).toBe('authority-cost');
    expect(h.dispatched).toEqual([]);

    await decide(h, service, card.id, 'accept');
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ jobId: 'onboard-swift-app', repoPath: realpathSync(repo.path), title: 'Onboard swift-app to GC' });
    expect(h.dispatched[0]!.briefing).toContain(git(repo.origin, 'rev-parse', 'refs/heads/main'));
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(h.rows(ONBOARDING_DISPATCHED_KIND)).toEqual([expect.objectContaining({ routing: 'fyi', title: 'Onboarding heist dispatched: swift-app' })]);
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({ repo: 'swift-app', job_id: 'onboard-swift-app', launched_by: 'owner-accept' })]);
  });

  it('Dispatch failure: a retryable row for Gru, the card stays answered, and the next reconcile carries the Accept out', async () => {
    const h = harness();
    h.repo('swift-app');
    const intervals: { readonly ms: number; readonly run: () => void }[] = [];
    const fakeInterval = ((run: () => void, ms: number) => { intervals.push({ ms, run }); return { unref() {} }; }) as unknown as typeof setInterval;
    const service = await started(h.service({ setInterval: fakeInterval }));
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    h.failDispatch = 'the dispatch service is not up yet';
    await decide(h, service, card.id, 'accept');
    const failed = h.rows(ONBOARDING_DISPATCH_FAILED_KIND);
    expect(failed).toEqual([expect.objectContaining({ routing: 'action-required', severity: 'error', resolvedAt: null, title: 'Onboarding heist not dispatched: swift-app' })]);
    expect(failed[0]!.detail).toContain('the dispatch service is not up yet');
    expect(h.ledger.getJob('onboard-swift-app')).toBeNull();
    expect(h.ledger.getNotification(card.id)).toMatchObject({ decidedOption: 'accept', resolvedAt: null });

    h.failDispatch = null;
    expect(intervals.map((entry) => entry.ms)).toEqual([ONBOARDING_RECONCILE_INTERVAL_MS]);
    intervals[0]!.run();
    await service.idle();
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app']);
    expect(h.ledger.getNotification(failed[0]!.id)?.resolvedAt).not.toBeNull();
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
  });

  it('Restart: a card still waiting gets no second card', async () => {
    const h = harness();
    h.repo('swift-app');
    const first = await started(h.service());
    first.stop();
    await started(h.service());
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toHaveLength(1);
    expect(h.events(ONBOARDING_EVENTS.proposed)).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
  });

  it('Onboarded: a manifest on origin\'s default branch posts nothing, even when the checkout has not pulled it', async () => {
    const h = harness();
    h.repo('web', { manifest: true });
    const merged = h.repo('api');
    merged.mergeManifest();
    expect(existsSync(join(merged.path, '.gru-command', 'worktree.toml'))).toBe(false);
    const service = await started(h.service());
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(await service.scan()).toEqual([
      expect.objectContaining({ repo: 'web', origin: 'present', action: 'none' }),
      expect.objectContaining({ repo: 'api', origin: 'present', action: 'none' }),
    ]);
  });

  it('Offline: an unreachable origin posts nothing and logs unverified, redacted; the next start checks again', async () => {
    const h = harness();
    const repo = h.repo('swift-app');
    const secret = join(tempDir('gru-onboarding-gone-'), 'ghp_abcdefghijklmnopqrstuvwx', 'swift-app.git');
    git(repo.path, 'remote', 'set-url', 'origin', secret);
    const offline = await started(h.service());
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    const unverified = h.logs.find((line) => line.level === 'warn' && line.msg.includes('origin manifest unverified'));
    expect(unverified?.fields['repo']).toBe('swift-app');
    expect(String(unverified?.fields['reason'])).toContain('[redacted]');
    expect(JSON.stringify(h.logs)).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    offline.stop();

    git(repo.path, 'remote', 'set-url', 'origin', repo.origin);
    await started(h.service());
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toHaveLength(1);
  });

  it('Declined: a Decline holds across scans and restarts; the propose route reopens it with a new card', async () => {
    const h = harness();
    h.repo('swift-app');
    const first = await started(h.service());
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    await decide(h, first, card.id, 'decline');
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(h.events(ONBOARDING_EVENTS.declined)).toEqual([expect.objectContaining({ repo: 'swift-app', by: 'owner', notification_id: card.id })]);
    expect(await first.scan()).toEqual([expect.objectContaining({ action: 'declined' })]);
    first.stop();

    const second = await started(h.service());
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toHaveLength(1);
    expect(h.dispatched).toEqual([]);

    const proposed = await second.propose('swift-app');
    expect(proposed).toMatchObject({ repo: 'swift-app', origin: 'missing', action: 'proposed', notificationId: `onboarding:${onboardingRepoKey('swift-app')}:2` });
    expect(h.events(ONBOARDING_EVENTS.reopened)).toEqual([expect.objectContaining({ repo: 'swift-app', requested_by: 'gru' })]);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND).filter((row) => row.resolvedAt === null)).toHaveLength(1);
  });

  it('Declined: binning an onboarding job is a decline; proposing again asks with a card, and Accept dispatches the next heist id', async () => {
    const h = harness();
    h.repo('swift-app');
    const service = await started(h.service({ mode: 'autonomous' }));
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app']);
    h.ledger.setJobStatus('onboard-swift-app', 'binned');
    await service.idle();
    expect(h.events(ONBOARDING_EVENTS.declined)).toEqual([expect.objectContaining({ repo: 'swift-app', job_id: 'onboard-swift-app' })]);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
    service.stop();

    const again = await started(h.service({ mode: 'autonomous' }));
    expect(h.dispatched).toHaveLength(1);
    // The first heist ended without a manifest: even autonomous mode asks.
    expect(await again.propose('swift-app')).toMatchObject({ action: 'proposed' });
    expect(h.dispatched).toHaveLength(1);
    await decide(h, again, h.rows(ONBOARDING_PROPOSAL_KIND)[0]!.id, 'accept');
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app', 'onboard2-swift-app']);
  });

  it('Open job: a non-terminal onboarding job means no card and no second job', async () => {
    const h = harness();
    h.repo('swift-app');
    const first = await started(h.service({ mode: 'autonomous' }));
    first.stop();
    h.ledger.setJobStatus('onboard-swift-app', 'working');
    for (const mode of ['autonomous', 'proposed'] as const) {
      const service = await started(h.service({ mode }));
      expect(await service.scan()).toEqual([expect.objectContaining({ action: 'job-open', jobId: 'onboard-swift-app' })]);
      service.stop();
    }
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
  });

  it('A terminal onboarding job rescans: merged with the manifest on origin posts nothing; done without it asks with a card, never a second automatic heist', async () => {
    const h = harness();
    const merged = h.repo('web');
    h.repo('api');
    const service = await started(h.service({ mode: 'autonomous' }));
    expect(h.dispatched.map((input) => input.jobId).sort()).toEqual(['onboard-api', 'onboard-web']);

    merged.mergeManifest();
    h.ledger.setJobStatus('onboard-web', 'working');
    h.ledger.setJobStatus('onboard-web', 'in-review');
    h.ledger.setJobStatus('onboard-web', 'merged');
    h.ledger.setJobStatus('onboard-api', 'working');
    h.ledger.setJobStatus('onboard-api', 'done');
    await service.idle();
    expect(h.dispatched).toHaveLength(2);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([expect.objectContaining({ title: 'Onboard api', resolvedAt: null })]);
  });
});

describe('installer consent (#427)', () => {
  it('Consent: dispatched at first start with no card; the consent is recorded with its source and the file removed; an onboarded repository settles', async () => {
    const h = harness();
    h.repo('swift-app');
    h.repo('web', { manifest: true });
    writeOnboardingConsent(h.instanceDir, ['swift-app', 'web', 'not-managed'], new Date('2026-10-16T08:00:00.000Z'));
    await started(h.service());
    expect(existsSync(onboardingConsentPath(h.instanceDir))).toBe(false);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app']);
    expect(h.events(ONBOARDING_EVENTS.consented).map((event) => event['repo'])).toEqual(['swift-app', 'web']);
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({
      repo: 'swift-app', launched_by: 'installer-consent', consent: { source: 'installer', recorded_at: '2026-10-16T08:00:00.000Z' },
    })]);
    expect(h.events(ONBOARDING_EVENTS.consentSettled)).toEqual([expect.objectContaining({ repo: 'web' })]);
    expect(h.rows(ONBOARDING_DISPATCHED_KIND)[0]?.detail).toContain('Consented in the installer (2026-10-16T08:00:00.000Z)');
    expect(h.logs.some((line) => line.level === 'warn' && line.fields['repo'] === 'not-managed')).toBe(true);
  });

  it('Consent: a crash between the dispatch and removing the file dispatches nothing twice (deterministic job id)', async () => {
    const h = harness();
    const repo = h.repo('swift-app');
    writeOnboardingConsent(h.instanceDir, ['swift-app']);
    // The previous process dispatched the heist, then died before removing the file.
    h.ledger.addJob({ id: onboardingJobId('swift-app', 1), repo: basename(repo.path), title: 'Onboard swift-app to GC' });
    await started(h.service());
    expect(h.dispatched).toEqual([]);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(existsSync(onboardingConsentPath(h.instanceDir))).toBe(false);
  });

  it('Consent waits in the ledger when origin cannot be read at that start, and is used at a later one', async () => {
    const h = harness();
    h.repo('swift-app');
    writeOnboardingConsent(h.instanceDir, ['swift-app']);
    const offline = await started(h.service({ probe: async () => ({ state: 'unverified', reason: 'origin could not be read: offline' }) }));
    expect(existsSync(onboardingConsentPath(h.instanceDir))).toBe(false);
    expect(h.dispatched).toEqual([]);
    offline.stop();
    await started(h.service());
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app']);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({ launched_by: 'installer-consent' })]);
  });

  it('Consent stands in for the owner\'s Accept on a card an earlier boot posted (the installer\'s smoke)', async () => {
    const h = harness();
    h.repo('swift-app');
    const smoke = await started(h.service());
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    smoke.stop();
    writeOnboardingConsent(h.instanceDir, ['swift-app']);
    await started(h.service());
    expect(h.ledger.getNotification(card.id)).toMatchObject({ decidedOption: 'accept', decidedBy: 'installer-consent' });
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({ job_id: 'onboard-swift-app', launched_by: 'installer-consent' })]);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toHaveLength(1);
  });

  it('Off: with a consent file, nothing is read, checked, posted or dispatched, and the propose route refuses', async () => {
    const h = harness();
    h.repo('swift-app');
    writeOnboardingConsent(h.instanceDir, ['swift-app']);
    let probed = 0;
    const service = await started(h.service({ mode: 'off', probe: async () => { probed += 1; return { state: 'unverified', reason: 'unused' }; } }));
    expect(probed).toBe(0);
    expect(h.dispatched).toEqual([]);
    expect(h.ledger.listNotifications({ limit: 50 })).toEqual([]);
    for (const kind of Object.values(ONBOARDING_EVENTS)) expect(h.events(kind)).toEqual([]);
    expect(existsSync(onboardingConsentPath(h.instanceDir))).toBe(true);
    await expect(service.propose('swift-app')).rejects.toThrow(OnboardingRefusal);
    await expect(service.propose('swift-app')).rejects.toMatchObject({ code: 'onboarding_off' });
  });
});

describe('failure rows, stale cards and follow-through (#427)', () => {
  const capture = (): { readonly intervals: (() => void)[]; readonly setInterval: typeof setInterval } => {
    const intervals: (() => void)[] = [];
    return { intervals, setInterval: ((run: () => void) => { intervals.push(run); return { unref() {} }; }) as unknown as typeof setInterval };
  };
  const openFailures = (h: Harness): readonly string[] => h.rows(ONBOARDING_DISPATCH_FAILED_KIND).filter((row) => row.resolvedAt === null).map((row) => row.id).sort();
  const cardTitled = (h: Harness, title: string): NotificationRecord => h.rows(ONBOARDING_PROPOSAL_KIND).find((row) => row.title === title)!;

  it('Failure rows: autonomous and consented dispatch failures (no card) are retried by the reconcile interval; Gru cannot dispose of the row', async () => {
    for (const launch of ['autonomous', 'installer-consent'] as const) {
      const h = harness();
      h.repo('swift-app');
      if (launch === 'installer-consent') writeOnboardingConsent(h.instanceDir, ['swift-app']);
      const timer = capture();
      h.failDispatch = 'the dispatch service is not up yet';
      const service = await started(h.service({ mode: launch === 'autonomous' ? 'autonomous' : 'proposed', setInterval: timer.setInterval }));
      expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
      expect(openFailures(h)).toEqual(['onboarding-dispatch-failed:onboard-swift-app:1']);
      const row = 'onboarding-dispatch-failed:onboard-swift-app:1';
      expect(() => h.ledger.disposeMachineNotification(row, 'handled it')).toThrow(MachineDispositionRefusedError);
      expect(h.ledger.machineDispositionRefusal(row)).toMatch(/closes itself on a dispatched onboarding heist, or a scan that finds none is needed/u);
      h.failDispatch = null;
      timer.intervals[0]!();
      await service.idle();
      expect(h.events(ONBOARDING_EVENTS.dispatched), launch).toEqual([expect.objectContaining({ job_id: 'onboard-swift-app', launched_by: launch })]);
      expect(h.ledger.getNotification(row)?.resolvedBy).toBe('onboarding-dispatched');
      expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    }
  });

  it('Failure rows close themselves when origin gains the manifest and when the repository is declined; a later failure posts a new open row', async () => {
    const h = harness();
    const web = h.repo('web');
    h.repo('api');
    const timer = capture();
    h.failDispatch = 'dispatch refused';
    const service = await started(h.service({ mode: 'autonomous', setInterval: timer.setInterval }));
    expect(openFailures(h)).toEqual(['onboarding-dispatch-failed:onboard-api:1', 'onboarding-dispatch-failed:onboard-web:1']);
    web.mergeManifest();
    // The decline a binned onboarding job records, appended the same way.
    h.ledger.appendCustomEvent({ kind: ONBOARDING_EVENTS.declined, payload: { repo: 'api', by: 'a binned onboarding job', detail: 'declined in this test' } });
    timer.intervals[0]!();
    await service.idle();
    expect(openFailures(h)).toEqual([]);
    for (const row of ['onboarding-dispatch-failed:onboard-web:1', 'onboarding-dispatch-failed:onboard-api:1']) expect(h.ledger.getNotification(row)?.resolvedBy).toBe('onboarding-scan');
    expect(h.dispatched).toEqual([]);
    // The owner asks again and the dispatch fails again: a new, open row.
    expect(await service.propose('api')).toMatchObject({ action: 'dispatch-failed' });
    expect(openFailures(h)).toEqual(['onboarding-dispatch-failed:onboard-api:2']);
  });

  it('A dispatch that fails after its job exists counts as dispatched: no failure row, and its FYI says the job is blocked, with the error', async () => {
    const h = harness();
    h.repo('swift-app');
    h.failAfterJob = 'worktree creation failed: disk full';
    const service = h.service({ mode: 'autonomous' });
    expect(await service.scan()).toEqual([expect.objectContaining({ action: 'dispatched', jobId: 'onboard-swift-app' })]);
    expect(h.rows(ONBOARDING_DISPATCH_FAILED_KIND)).toEqual([]);
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({ job_id: 'onboard-swift-app', launched_by: 'autonomous' })]);
    const fyi = h.rows(ONBOARDING_DISPATCHED_KIND);
    expect(fyi).toEqual([expect.objectContaining({ routing: 'fyi', title: 'Onboarding heist blocked at dispatch: swift-app' })]);
    expect(fyi[0]!.detail).toContain('job onboard-swift-app exists but is blocked: worktree creation failed: disk full');
  });

  it('A repository that left managed_repos gets no heist: an Accept reaching it closes the card, and at start its undecided card is withdrawn and its answered one closed', async () => {
    const h = harness();
    h.repo('web');
    h.repo('api');
    h.repo('docs');
    const first = await started(h.service());
    first.stop();
    h.notifications.decide(cardTitled(h, 'Onboard api').id, 'accept', 'owner');
    h.notifications.decide(cardTitled(h, 'Onboard docs').id, 'accept', 'owner');
    expect(await h.service({ managed: [] }).scan(['docs'])).toEqual([expect.objectContaining({ action: 'none', detail: 'not a managed repository' })]);
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard docs').id)?.resolvedAt).not.toBeNull();
    await started(h.service({ managed: [] }));
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard web').id)).toMatchObject({ resolvedBy: 'producer-withdrawn', decidedOption: null });
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard api').id)).toMatchObject({ decidedOption: 'accept' });
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard api').id)?.resolvedAt).not.toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it('Mode off withdraws earlier undecided cards and closes answered ones at start; nothing is dispatched', async () => {
    const h = harness();
    h.repo('web');
    h.repo('api');
    const first = await started(h.service());
    first.stop();
    h.notifications.decide(cardTitled(h, 'Onboard api').id, 'accept', 'owner');
    await started(h.service({ mode: 'off' }));
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard web').id)).toMatchObject({ resolvedBy: 'producer-withdrawn', decidedOption: null });
    expect(h.ledger.getNotification(cardTitled(h, 'Onboard api').id)?.resolvedAt).not.toBeNull();
    expect(h.rows(ONBOARDING_PROPOSAL_KIND).filter((row) => row.resolvedAt === null)).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it('stop() during an accepted card\'s follow-through dispatches nothing; the answered card waits for the next start', async () => {
    const h = harness();
    h.repo('swift-app');
    const first = await started(h.service());
    first.stop();
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    let probing = 0;
    const service = await started(h.service({
      probe: (_path, { signal }) => {
        probing += 1;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ state: 'unverified', reason: 'the probe deadline passed before git started' }), { once: true }));
      },
    }));
    h.notifications.decide(card.id, 'accept', 'owner');
    await vi.waitFor(() => expect(probing).toBe(1));
    service.stop();
    await service.idle();
    expect(h.dispatched).toEqual([]);
    expect(h.ledger.getNotification(card.id)).toMatchObject({ decidedOption: 'accept', resolvedAt: null });
    expect(h.rows(ONBOARDING_DISPATCH_FAILED_KIND)).toEqual([]);
  });

  it('Accept after origin gained the manifest dispatches nothing and closes the card', async () => {
    const h = harness();
    const repo = h.repo('swift-app');
    const first = await started(h.service());
    first.stop();
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    repo.mergeManifest();
    h.notifications.decide(card.id, 'accept', 'owner');
    expect(await h.service().scan()).toEqual([expect.objectContaining({ action: 'none', origin: 'present', notificationId: card.id })]);
    expect(h.dispatched).toEqual([]);
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
  });

  it('Accept while origin cannot be read still dispatches, with a briefing that says GC could not read origin', async () => {
    const h = harness();
    h.repo('swift-app');
    const first = await started(h.service());
    first.stop();
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    h.notifications.decide(card.id, 'accept', 'owner');
    const service = h.service({ probe: async () => ({ state: 'unverified', reason: 'origin could not be read: offline' }) });
    expect(await service.scan()).toEqual([expect.objectContaining({ action: 'dispatched', origin: 'unverified', jobId: 'onboard-swift-app' })]);
    expect(h.dispatched[0]!.briefing).toContain('GC could not read origin when this heist was dispatched');
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
  });

  it('A restart with an accepted card still open and its onboarding job open closes the card and dispatches nothing more', async () => {
    const h = harness();
    const repo = h.repo('swift-app');
    const first = await started(h.service());
    first.stop();
    const card = h.rows(ONBOARDING_PROPOSAL_KIND)[0]!;
    h.notifications.decide(card.id, 'accept', 'owner');
    // The heist was dispatched, then the process died before closing the card.
    h.ledger.addJob({ id: 'onboard-swift-app', repo: basename(repo.path), title: 'Onboard swift-app to GC' });
    await started(h.service());
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it('A malformed consent file is not applied: no consent recorded, the file kept, an error logged, and a card posted', async () => {
    const h = harness();
    h.repo('swift-app');
    writeFileSync(join(h.instanceDir, ONBOARDING_CONSENT_FILE), '{"version": 1, "repos": "swift-app"');
    await started(h.service());
    expect(h.events(ONBOARDING_EVENTS.consented)).toEqual([]);
    expect(existsSync(onboardingConsentPath(h.instanceDir))).toBe(true);
    expect(h.logs.some((line) => line.level === 'error' && line.msg.includes('consent file is unreadable'))).toBe(true);
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
  });
});

describe('autonomous mode, boot path and briefing (#427)', () => {
  it('Autonomous: dispatches the heist and posts an FYI row, no card', async () => {
    const h = harness();
    h.repo('swift-app');
    await started(h.service({ mode: 'autonomous' }));
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched.map((input) => input.jobId)).toEqual(['onboard-swift-app']);
    expect(h.rows(ONBOARDING_DISPATCHED_KIND)).toEqual([expect.objectContaining({ routing: 'fyi', detail: expect.stringContaining('onboarding mode = "autonomous"') })]);
    expect(h.events(ONBOARDING_EVENTS.dispatched)).toEqual([expect.objectContaining({ launched_by: 'autonomous' })]);
  });

  it('start never waits on origin, and stop aborts an in-flight probe: it acts on nothing', async () => {
    const h = harness();
    h.repo('swift-app');
    let probing = 0;
    const service = h.service({
      probe: (_path, { signal }) => {
        probing += 1;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ state: 'unverified', reason: 'the probe deadline passed before git started' }), { once: true }));
      },
    });
    service.start();
    await vi.waitFor(() => expect(probing).toBe(1));
    service.stop();
    await service.idle();
    expect(h.rows(ONBOARDING_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it('the onboarding card is an owner decision kind; job ids are deterministic, job-id safe and never collide across attempts', () => {
    expect(ownerAttentionFor(ONBOARDING_PROPOSAL_KIND)).toBe('owner-required');
    expect(requiresTypedDecision(ONBOARDING_PROPOSAL_KIND)).toBe(true);
    expect(ownerAttentionFor(ONBOARDING_DISPATCH_FAILED_KIND)).toBe('owner-forbidden');
    expect(onboardingJobId('swift-app', 1)).toBe('onboard-swift-app');
    expect(onboardingJobId('swift-app', 2)).toBe('onboard2-swift-app');
    const odd = onboardingJobId('Swift App ✓', 1);
    expect(odd).toMatch(/^onboard-swift-app-[0-9a-f]{10}$/u);
    expect(onboardingJobId('Swift App ✓', 1)).toBe(odd);
    for (const id of [odd, onboardingJobId('2fa', 1), onboardingJobId('2fa', 12)]) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
    expect(onboardingKeyOfJob('onboard-2fa')).toBe('2fa');
    expect(onboardingKeyOfJob('onboard12-2fa')).toBe('2fa');
    expect(onboardingKeyOfJob('onboard1-2fa')).toBeNull();
    expect(onboardingKeyOfJob('fix-onboard-2fa')).toBeNull();
    // Names git refuses at the end of the lane branch take the slug+hash path.
    const root = tempDir('gru-onboarding-refs-');
    git(root, 'init', '-q', '-b', 'main');
    for (const name of ['a..b', 'app.lock', 'app.', 'x.lock.lock', '..lock']) {
      const key = onboardingRepoKey(name);
      expect(key, name).toMatch(/-[0-9a-f]{10}$|^[0-9a-f]{10}$/u);
      expect(key, name).not.toContain('..');
      for (const attempt of [1, 2]) git(root, 'check-ref-format', `refs/heads/gru/${onboardingJobId(name, attempt)}`);
    }
    expect(onboardingRepoKey('a..b')).toMatch(/^a-b-[0-9a-f]{10}$/u);
    expect(onboardingRepoKey('app.lock')).toMatch(/^app-[0-9a-f]{10}$/u);
  });

  it('the briefing names no language or tool and tells the minion where to look, what to write and what to open', () => {
    const briefing = renderOnboardingBriefing({ repo: 'swift-app', origin: { defaultBranch: 'main', headSha: 'a'.repeat(40) } });
    const ecosystem = /\b(?:npm|npx|yarn|pnpm|node|nodejs|bun|deno|javascript|typescript|python|pip|pipenv|poetry|uv|ruby|bundler?|gem|rake|go|golang|rust|cargo|java|maven|mvn|gradle|kotlin|swift|swiftpm|xcode|xcodebuild|cocoapods|carthage|dotnet|nuget|php|composer|elixir|mix|haskell|stack|cabal|make|makefile|cmake|bazel|docker|lockfile|package\.json|requirements\.txt|gemfile)\b/iu;
    expect(briefing.replace(/swift-app/gu, '<repo>')).not.toMatch(ecosystem);
    expect(briefing).toMatch(/CI configuration, its build and dependency files, and its README/u);
    expect(briefing).toMatch(/Derive every command from what the project already runs or documents/u);
    expect(briefing).toMatch(/without any prompt or input, and must be idempotent/u);
    expect(briefing).toMatch(/reclaim: the repo-relative folders that setup or builds create and that git already ignores/u);
    expect(briefing).toMatch(/Change no other files/u);
    expect(briefing).toContain('open a pull request titled "Onboard swift-app to GC"');
    expect(briefing).toMatch(/When the repository has no CI and no test command, leave \[verify\] out and say so in the PR body/u);
    expect(briefing).toMatch(/Never write a setup command that needs a secret .*; name the secret in the PR body instead/u);
    expect(briefing).toContain('Before opening a PR, look for an open PR titled "Onboard swift-app to GC" from an earlier onboarding heist; if there is one, update it instead of opening a duplicate');
    expect(briefing).toContain(`at ${'a'.repeat(40)}`);
    const unverified = renderOnboardingBriefing({ repo: 'swift-app', origin: null });
    expect(unverified).toContain('GC could not read origin when this heist was dispatched');
    expect(unverified.replace(/swift-app/gu, '<repo>')).not.toMatch(ecosystem);
  });

  it('POST /api/onboarding/propose: authed, answers with the scan, and names every refusal', async () => {
    const h = harness();
    h.repo('swift-app');
    const service = await started(h.service());
    const token = 'onboarding-route-token';
    const listen = async (target: OnboardingService): Promise<number> => {
      const server: Server = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!createOnboardingServer({ token, service: target }).requestHook(req, res, path)) {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => server.close());
      return (server.address() as AddressInfo).port;
    };
    const port = await listen(service);
    const offPort = await listen(h.service({ mode: 'off' }));
    const post = (body: string, auth = true, to = port): Promise<{ status: number; json: Record<string, unknown> }> => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: to, path: '/api/onboarding/propose', method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(body);
    });
    expect((await post('{"repo":"swift-app"}', false)).status).toBe(401);
    expect(await post('{"repo":"swift-app"}')).toEqual({ status: 200, json: expect.objectContaining({ repo: 'swift-app', origin: null, action: 'card-open' }) });
    expect(await post('{"repo":"elsewhere"}')).toEqual({ status: 422, json: expect.objectContaining({ error: 'not_managed' }) });
    expect(await post('{"repo":"swift-app","mode":"autonomous"}')).toEqual({ status: 422, json: expect.objectContaining({ error: 'invalid_request' }) });
    expect((await post('not json')).status).toBe(400);
    expect(await post('{"repo":"swift-app"}', true, offPort)).toEqual({ status: 409, json: expect.objectContaining({ error: 'onboarding_off' }) });
  });
});
