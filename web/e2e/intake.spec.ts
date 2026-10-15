import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startRealService, type RealServiceHandle } from '../../test/helpers/real-service.mjs';
import { resolvedIntakePlan } from '../../test/helpers/intake-plan.js';
import type { IntakeReadback, Proposal } from '../../src/intake/types.js';
let service: RealServiceHandle;
let root: string;
let repo: string;
const token = 'intake-browser-fixture';
test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-intake-browser-')));
  const home = join(root, 'home'), workspace = join(root, 'workspace'); repo = join(workspace, 'app');
  mkdirSync(repo, { recursive: true }); mkdirSync(join(home, 'bin'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'spec.md'), 'Implement exact native capture.\n');
  writeFileSync(join(repo, 'unreadable.md'), 'Source selected before it becomes unreadable.\n');
  writeFileSync(join(repo, 'story.md'), '---\nstatus: done\n---\nImplement native document review.\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const origin = join(root, 'origin.git'); execFileSync('git', ['clone', '--bare', '-q', repo, origin]); execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  const issueRepo = join(workspace, 'issue-app'); execFileSync('git', ['clone', '-q', repo, issueRepo]); execFileSync('git', ['-C', issueRepo, 'remote', 'set-url', 'origin', 'https://github.com/owner/issue-app.git']);
  // All external GitHub/model boundaries are offline doubles, never network.
  writeFileSync(join(home, 'bin', 'gh'), `#!/usr/bin/env node\nif (process.argv.includes('repos/owner/issue-app/issues/1')) process.stdout.write(JSON.stringify({ number: 1, html_url: 'https://github.com/owner/issue-app/issues/1', title: 'Capture', body: 'Implement native capture.', updated_at: '2026-10-10T12:00:00Z' })); else process.stdout.write('[]');\n`, { mode: 0o755 });
  service = await startRealService({ port: 0, token, home, workspace, managedRepos: ['app', 'issue-app'] });
});
test.afterAll(async () => { await service?.stop(); rmSync(root, { recursive: true, force: true }); });
async function pair(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(service.baseUrl);
  await page.locator('#pair-token').fill(token); await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible(); await page.getByText('Review source intake', { exact: true }).click();
}
async function selectRepo(page: Page, name = 'app'): Promise<void> {
  await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
  await page.locator(`.attach-row[data-kind="dir"][data-name="${name}"]`).click();
  await page.getByRole('button', { name: 'Use this repository', exact: true }).click();
}
async function pickDocument(page: Page, name: string, repository = 'app'): Promise<void> {
  await page.getByRole('button', { name: 'Browse / upload documents', exact: true }).click();
  await page.locator(`.attach-row[data-kind="dir"][data-name="${repository}"]`).click();
  await page.locator(`.attach-row[data-kind="file"][data-name="${name}"]`).click();
}
test('all three sources preview and reject with zero executable jobs; chat and board remain usable', async ({ page }) => {
  await pair(page);
  for (const kind of ['issue', 'spec', 'bmad']) {
    await selectRepo(page, kind === 'issue' ? 'issue-app' : 'app'); await page.getByLabel('Intake source', { exact: true }).selectOption(kind);
    if (kind === 'issue') await page.getByLabel('Issue reference', { exact: true }).fill('#1');
    else await pickDocument(page, kind === 'spec' ? 'spec.md' : 'story.md');
    await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
    await expect(page.locator('.intake-status')).toContainText('zero executable work');
    await expect(page.locator('.intake-review')).toContainText('Snapshot revision:');
    await expect(page.locator('.intake-review')).toContainText('Verification:');
    await page.getByRole('button', { name: 'Review this revision', exact: true }).click();
    await page.getByRole('button', { name: 'Reject revision', exact: true }).click();
    await expect(page.locator('.intake-status')).toContainText('rejected. Accepted: none');
    await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toBeDisabled();
  }
  const jobs = await page.request.get(`${service.baseUrl}/api/pipeline`, { headers: { authorization: `Bearer ${token}` } }); expect((await jobs.json()).pending).toBe(0);
  await page.locator('.intake > summary').click();
  await page.locator('#chat-input').fill('native intake preview is readable'); await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user').last()).toContainText('native intake preview is readable');
  await expect(page.locator('#board-view')).toBeVisible();
});
test('committed revision response loss reloads its original pending identity without replacement POSTs', async ({ page }) => {
  await pair(page); await selectRepo(page); await page.getByLabel('Intake source', { exact: true }).selectOption('spec'); await pickDocument(page, 'spec.md');
  const preview = page.waitForResponse((response) => response.url().endsWith('/api/intake/preview') && response.ok());
  await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
  const initial = await (await preview).json() as Proposal;
  await expect(page.locator('.intake-status')).toContainText('zero executable work');
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).draft as { repoPath: string; intakeId: string; requestId: string });
  let revisions = 0, approvals = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/intake/approve')) approvals += 1; });
  await page.route('**/api/intake/revision', async (route) => { revisions += 1; const committed = await route.fetch(); expect(committed.status()).toBe(200); await route.abort('failed'); });
  await page.getByLabel('Concrete intake plan JSON', { exact: true }).fill(JSON.stringify(resolvedIntakePlan(initial), null, 2));
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('Response lost');
  const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision as { identity: { repoPath: string; intakeId: string; requestId: string }; previous: unknown });
  expect(pending).not.toBeNull(); expect(pending.previous).toEqual(before); expect(pending.identity.requestId).not.toBe(before.requestId);
  const recovered = await page.request.get(`${service.baseUrl}/api/intake/${encodeURIComponent(pending.identity.intakeId)}/requests/${encodeURIComponent(pending.identity.requestId)}?${new URLSearchParams({ repoPath: pending.identity.repoPath })}`, { headers: { authorization: `Bearer ${token}` } });
  expect(recovered.status()).toBe(200); const exact = await recovered.json() as Proposal;
  await page.reload(); await page.getByText('Review source intake', { exact: true }).click();
  await expect(page.locator('.intake-review')).toContainText(exact.revisionId);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision)).toBeNull();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).draft)).toEqual(pending.identity);
  await page.getByRole('button', { name: 'Read back / recover', exact: true }).click();
  await expect(page.locator('.intake-review')).toContainText(exact.revisionId);
  expect(revisions).toBe(1); expect(approvals).toBe(0);
});

test('concrete edits, dependency refusal, lost approval response and reload/reconnect retain accepted identities', async ({ page }) => {
  await pair(page); await selectRepo(page); await page.getByLabel('Intake source', { exact: true }).selectOption('spec'); await pickDocument(page, 'spec.md');
  let captured!: Proposal;
  page.on('response', async (response) => { if (response.url().endsWith('/api/intake/preview') && response.ok()) captured = await response.json() as Proposal; });
  await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('zero executable work');
  await expect.poll(() => captured?.revisionId).toBeTruthy();
  const plan = resolvedIntakePlan(captured); const heist = plan.heists[0]!;
  const split = { ...plan, heists: [{ ...heist, id: 'first' }, { ...heist, id: 'second', dependencies: [{ text: 'Wait for delivered first.', traces: [], clarification: true, id: 'first', milestone: 'delivered' }] }] };
  await page.getByLabel('Concrete intake plan JSON', { exact: true }).fill(JSON.stringify(split, null, 2));
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click(); await expect(page.locator('.intake-status')).toContainText('New captured revision');
  await page.getByRole('button', { name: 'Review this revision', exact: true }).click();
  await page.getByLabel('Select second', { exact: true }).check(); await page.getByRole('button', { name: 'Approve selected work', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('Select prerequisite first');
  await page.getByLabel('Select first', { exact: true }).check();
  await page.route('**/api/intake/approve', async (route) => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Approve selected work', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('Response lost');
  await page.reload(); await page.getByText('Review source intake', { exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('approved. Accepted:');
  const read = await page.request.get(`${service.baseUrl}/api/pipeline`, { headers: { authorization: `Bearer ${token}` } }); expect(read.ok()).toBe(true);
  const identities = await page.locator('.intake-status').textContent();
  await page.getByRole('button', { name: 'Read back / recover', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('approved. Accepted:');
  expect(identities).toContain('first → intake-'); expect(identities).toContain('second → intake-');
  await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toHaveCount(0);
});

async function concreteReview(page: Page): Promise<{ proposal: Proposal; review: IntakeReadback }> {
  await pair(page); await selectRepo(page);
  await page.getByLabel('Intake source', { exact: true }).selectOption('spec');
  await pickDocument(page, 'spec.md');
  const preview = page.waitForResponse((response) => response.url().endsWith('/api/intake/preview') && response.ok());
  await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
  const initial = await (await preview).json() as Proposal;
  await expect(page.locator('.intake-status')).toContainText('zero executable work');
  await page.getByLabel('Concrete intake plan JSON', { exact: true }).fill(JSON.stringify(resolvedIntakePlan(initial), null, 2));
  const revised = page.waitForResponse((response) => response.url().endsWith('/api/intake/revision') && response.ok());
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  const proposal = await (await revised).json() as Proposal;
  await expect(page.locator('.intake-status')).toContainText('New captured revision');
  const reviewed = page.waitForResponse((response) => response.url().endsWith('/api/intake/review') && response.ok());
  await page.getByRole('button', { name: 'Review this revision', exact: true }).click();
  const review = await (await reviewed).json() as IntakeReadback;
  await expect(page.locator('.intake-status')).toContainText('Reviewed.');
  await page.getByLabel('Select heist-1', { exact: true }).check();
  return { proposal, review };
}

test('an unreadable selected source stays a visible non-executable gap', async ({ page }) => {
  await pair(page); await selectRepo(page);
  await page.getByLabel('Intake source', { exact: true }).selectOption('spec');
  await pickDocument(page, 'unreadable.md');
  rmSync(join(repo, 'unreadable.md'));
  try {
    await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
    await expect(page.locator('.intake-status')).toContainText('zero executable work');
    await expect(page.locator('.intake-review')).toContainText('unreadable.md');
    await expect(page.locator('.intake-review')).not.toContainText('Source gaps: none');
    await page.getByRole('button', { name: 'Review this revision', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toBeDisabled();
  } finally { writeFileSync(join(repo, 'unreadable.md'), 'Source selected before it becomes unreadable.\n'); }
});

test('another owner decision invalidates a stale browser approval without enqueue', async ({ page }) => {
  const { proposal, review } = await concreteReview(page);
  const rejected = await page.request.post(`${service.baseUrl}/api/intake/reject`, {
    headers: { authorization: `Bearer ${token}` },
    data: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId, expectedToken: review.review!.token },
  });
  expect(rejected.ok()).toBe(true);
  await page.getByRole('button', { name: 'Approve selected work', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('Review changed or was rejected');
  await page.getByRole('button', { name: 'Read back / recover', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('rejected. Accepted: none');
  await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toBeDisabled();
  expect((await rejected.json() as IntakeReadback).accepted).toEqual([]);
});

test('duplicate browser clicks issue one explicit approval and one accepted entry', async ({ page }) => {
  await concreteReview(page);
  let approvalCalls = 0;
  let accepted!: IntakeReadback;
  await page.route('**/api/intake/approve', async (route) => {
    approvalCalls += 1;
    const response = await route.fetch();
    accepted = await response.json() as IntakeReadback;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Approve selected work', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.locator('.intake-status')).toContainText('approved. Accepted:');
  expect(approvalCalls).toBe(1);
  expect(accepted.accepted).toHaveLength(1);
  expect(accepted.remaining).toEqual([]);
});

async function retainedPairingIntents(page: Page): Promise<{ readonly saved: string; readonly approvalToken: string; readonly requestId: string }> {
  const { proposal } = await concreteReview(page);
  await page.getByRole('button', { name: 'Approve selected work', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('approved. Accepted:');
  await page.route('**/api/intake/revision', (route) => route.abort('failed'));
  await page.getByLabel('Concrete intake plan JSON', { exact: true }).fill(JSON.stringify({ ...proposal.plan, questions: ['New uncommitted local clarification'] }, null, 2));
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click();
  await expect(page.locator('.intake-status')).toContainText('Response lost');
  const saved = await page.evaluate(() => sessionStorage.getItem('gru-intake-recovery')!);
  const state = JSON.parse(saved) as { draft: unknown; pendingRevision: unknown; approvals: { request: { requestId: string }; token: string }[] };
  expect(state.draft).not.toBeNull(); expect(state.pendingRevision).not.toBeNull(); expect(state.approvals).toHaveLength(1);
  expect(state.approvals[0]!.token).toMatch(/^[0-9a-f]{64}$/u);
  return { saved, approvalToken: state.approvals[0]!.token, requestId: state.approvals[0]!.request.requestId };
}

test('automatic fatal and wrong-credential pairing preserve exact intake identities without decision replay', async ({ page }) => {
  let fail!: () => void;
  await page.routeWebSocket(/\/board\/ws$/u, (socket) => {
    let authenticated = false;
    socket.onMessage(() => { if (!authenticated) { authenticated = true; socket.send(JSON.stringify({ type: 'auth_ok' })); } });
    fail = () => socket.send(JSON.stringify({ type: 'error', message: 'Injected protocol failure', fatal: true }));
  });
  let approvals = 0, revisions = 0;
  page.on('request', (request) => { if (request.method() !== 'POST') return; if (request.url().endsWith('/api/intake/approve')) approvals += 1; if (request.url().endsWith('/api/intake/revision')) revisions += 1; });
  const { saved } = await retainedPairingIntents(page);
  fail(); await expect(page.locator('#pairing-view')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('gru-intake-recovery'))).toBe(saved);
  await page.locator('#pair-token').fill('wrong-intake-recovery-credential'); await page.locator('#pair-submit').click();
  await expect(page.locator('#pair-error')).toContainText(/unauthori[sz]ed|authentication|invalid token/iu);
  expect(await page.evaluate(() => sessionStorage.getItem('gru-intake-recovery'))).toBe(saved);
  await page.locator('#pair-token').fill(token); await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible(); await page.getByText('Review source intake', { exact: true }).click();
  await expect(page.locator('.intake-review')).toContainText('Snapshot revision:');
  const original = JSON.parse(saved) as { pendingRevision: { previous: unknown }; approvals: unknown };
  const recovered = await page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery')!));
  expect(recovered).toEqual({ draft: original.pendingRevision.previous, pendingRevision: original.pendingRevision, approvals: original.approvals });
  expect(approvals).toBe(1); expect(revisions).toBe(2);
});

test('explicit Unpair clears draft, pending revision and original approval tokens before reload and re-pair', async ({ page }) => {
  let approvals = 0, revisions = 0;
  page.on('request', (request) => { if (request.method() !== 'POST') return; if (request.url().endsWith('/api/intake/approve')) approvals += 1; if (request.url().endsWith('/api/intake/revision')) revisions += 1; });
  const { approvalToken, requestId } = await retainedPairingIntents(page);
  const readRecovery = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('gru-intake-recovery') ?? '{"draft":null,"pendingRevision":null,"approvals":[]}'));
  const empty = { draft: null, pendingRevision: null, approvals: [] };
  await page.locator('#settings-toggle').click(); await page.locator('#settings-unpair').click();
  await expect(page.locator('#pairing-view')).toBeVisible();
  expect(await readRecovery()).toEqual(empty);
  await page.reload(); await expect(page.locator('#pairing-view')).toBeVisible();
  expect(await readRecovery()).toEqual(empty);
  await page.locator('#pair-token').fill(token); await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible(); await page.getByText('Review source intake', { exact: true }).click();
  await expect(page.locator('.intake-approval-recovery')).toBeHidden(); await expect(page.locator('.intake-review')).toBeEmpty();
  await expect(page.locator('.intake')).not.toContainText(`Original approval ${requestId}`);
  expect(await readRecovery()).toEqual(empty);
  expect(await page.evaluate((value) => sessionStorage.getItem('gru-intake-recovery')?.includes(value) ?? false, approvalToken)).toBe(false);
  expect(approvals).toBe(1); expect(revisions).toBe(2);
});

test('failed supporting batch blocks narrowed intake decisions while ordinary chat remains independent', async ({ page }) => {
  await concreteReview(page);
  let approvals = 0, previews = 0;
  page.on('request', (request) => { if (request.method() !== 'POST') return; if (request.url().endsWith('/api/intake/approve')) approvals += 1; if (request.url().endsWith('/api/intake/preview')) previews += 1; });
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/attach/uploads', async (route) => { await hold; await route.fulfill({ status: 503, json: { error: 'injected_upload_failure' } }); });
  await page.getByRole('button', { name: 'Browse / upload documents', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.locator('#attach-picker-device').click();
  await (await chooser).setFiles({ name: 'missing-support.md', mimeType: 'text/markdown', buffer: Buffer.from('required supporting detail') });
  await expect(page.locator('.intake-status')).toContainText('complete document upload batch');
  await expect(page.locator('#chat-chips .attach-chip')).toHaveCount(0);
  await page.locator('#chat-input').fill('ordinary chat remains independent'); await page.locator('#chat-send').click();
  await expect(page.locator('#chat-input')).toHaveValue('');
  release(); await expect(page.locator('.intake-status')).toContainText('upload failed');
  await expect(page.getByRole('button', { name: 'Preview sources', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toBeDisabled();
  expect(previews).toBe(0); expect(approvals).toBe(0);
  await page.getByRole('button', { name: 'Abandon failed document selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve selected work', exact: true })).toBeEnabled();
  expect(previews).toBe(0); expect(approvals).toBe(0);
});

test('intake stays in a bounded explicit row above chat on desktop, tablet and phone', async ({ page }) => {
  await pair(page);
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width < 1100 && await page.locator('#chat-sheet').getAttribute('data-open') !== 'true') await page.locator('#gru-fab').click();
    await expect(page.locator('#intake-mount')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const intake = rect('intake-mount'), log = rect('chat-log'), composer = rect('chat-form'), panel = rect('chat-view');
      return { intakeBottom: intake.bottom, logTop: log.top, logHeight: log.height, intakeHeight: intake.height, panelHeight: panel.height, composerBottom: composer.bottom, panelBottom: panel.bottom };
    });
    expect(geometry.intakeBottom).toBeLessThanOrEqual(geometry.logTop + 1);
    expect(geometry.intakeHeight).toBeLessThanOrEqual(geometry.panelHeight * 0.53);
    expect(geometry.logHeight).toBeGreaterThan(30);
    expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.panelBottom + 1);
    await page.locator('.intake > summary').click();
    const collapsed = await page.evaluate(() => {
      const mount = document.getElementById('intake-mount')!.getBoundingClientRect();
      const summary = document.querySelector('.intake > summary')!.getBoundingClientRect();
      return { mountBottom: mount.bottom, summaryBottom: summary.bottom };
    });
    expect(collapsed.summaryBottom).toBeLessThanOrEqual(collapsed.mountBottom);
    await page.locator('.intake > summary').click();
  }
});

test('device chooser uploads captured intake bytes without a ready chat attachment', async ({ page }) => {
  await pair(page); await selectRepo(page);
  await page.getByLabel('Intake source', { exact: true }).selectOption('spec');
  await page.getByRole('button', { name: 'Browse / upload documents', exact: true }).click();
  const chosen = page.waitForEvent('filechooser');
  await page.locator('#attach-picker-device').click();
  const bytes = '# Uploaded source\nImplement the device-upload intake capture contract.\n';
  await (await chosen).setFiles({ name: 'device-intake.md', mimeType: 'text/markdown', buffer: Buffer.from(bytes) });
  await expect(page.locator('.intake-documents')).toContainText('Primary: device-intake.md');
  await expect(page.locator('#chat-chips .attach-chip:not(.attach-chip--busy)')).toHaveCount(0);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/intake/preview') && response.ok());
  await page.getByRole('button', { name: 'Preview sources', exact: true }).click();
  const captured = await (await response).json() as Proposal;
  expect(captured.snapshots[0]!.raw).toBe(bytes);
  expect(captured.snapshots[0]!.text).toBe(bytes);
  expect(captured.executable).toBe(false);
  await expect(page.locator('#chat-chips .attach-chip:not(.attach-chip--busy)')).toHaveCount(0);
});

test('intake fails closed with unavailable session storage while chat keeps its safe fallback', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get: () => { throw new Error('Storage unavailable'); } }); });
  await pair(page);
  await expect(page.locator('.intake-status')).toContainText('intake_recovery_storage_error');
  await expect(page.getByRole('button', { name: 'Preview sources', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Choose repository', exact: true })).toBeDisabled();
  const posts: string[] = []; page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/intake/')) posts.push(request.url()); });
  await page.locator('.intake > summary').click(); await page.locator('#chat-input').fill('chat safe fallback remains available'); await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user').last()).toContainText('chat safe fallback remains available'); expect(posts).toEqual([]);
});

test('supporting device batch blocks preview until its complete captured selection arrives', async ({ page }) => {
  await pair(page); await selectRepo(page); await page.getByLabel('Intake source', { exact: true }).selectOption('spec'); await pickDocument(page, 'spec.md');
  let release!: () => void;
  await page.route('**/api/attach/uploads', async (route) => { await new Promise<void>((resolve) => { release = resolve; }); await route.continue(); });
  await page.getByRole('button', { name: 'Browse / upload documents', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.locator('#attach-picker-device').click();
  await (await chooser).setFiles({ name: 'support.md', mimeType: 'text/markdown', buffer: Buffer.from('Explicit supporting captured bytes.\n') });
  await expect.poll(() => typeof release).toBe('function');
  await expect(page.getByRole('button', { name: 'Preview sources', exact: true })).toBeDisabled();
  await expect(page.locator('.intake-status')).toContainText('complete document upload batch');
  release(); await expect(page.getByRole('button', { name: 'Remove support.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview sources', exact: true })).toBeEnabled();
  const response = page.waitForResponse((response) => response.url().endsWith('/api/intake/preview') && response.ok());
  await page.getByRole('button', { name: 'Preview sources', exact: true }).click(); const captured = await (await response).json() as Proposal;
  expect(captured.snapshots).toHaveLength(2); expect(captured.snapshots[0]!.raw).toBe('Implement exact native capture.\n'); expect(captured.snapshots[1]!.raw).toBe('Explicit supporting captured bytes.\n');
  await expect(page.locator('#chat-chips .attach-chip:not(.attach-chip--busy)')).toHaveCount(0);
});
