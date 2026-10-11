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
  service = await startRealService({ port: 0, token, home, workspace });
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
