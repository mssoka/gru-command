import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrMediaConfig } from '../config.js';
import type { EventRecord } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import { isTerminalJobStatus } from '../ledger/states.js';
import { redactCredentials } from '../redaction.js';
import { readOwnerEvidence, type BranchEvidenceLedger, type OwnerPrMediaPublication, type OwnerPrMediaView } from '../board/owner-actions.js';
import { isGitLabMrHost, parseGitLabMrLink } from '../dispatch/review-path.js';
import { parseGitHubPrUrl } from '../dispatch/github-poll.js';
import { listMedia, mediaAtHead, mediaExtension, readMediaBytes, type MediaItem, type MediaLedger } from './store.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The PR media publisher (owner rulings 2026-11-15: Q3 "PR body section,
 * replaced each head", Q5 "on by default, autonomous").
 *
 * Ticked with the GitHub/GitLab signal polls. For each live job whose open
 * PR/MR has captures bound to its CURRENT observed head, it writes one GC-owned
 * section into the description, between two markers, replacing the previous
 * one. Everything outside the markers is left byte-for-byte as it was.
 *
 *   GitHub: `gh pr edit --body-file … --attach …` (gh ≥ 2.99) uploads the
 *           files; the body references them as `./gc-media-N.ext`, which gh
 *           rewrites to the uploaded assets. Whatever gh appends instead
 *           (a video player has no alt text) is moved back inside the
 *           section, and the result is verified before it counts.
 *   GitLab: the project uploads API, then the MR description update, with
 *           the same `GITLAB_TOKEN`/`GL_TOKEN` the MR reads use, sent only to
 *           a host the service supports.
 *
 * Durable truth on both sides of the write: `media.publish-attempt` is
 * journaled before it, `media.published` (with the digest of the head and
 * captures it carries) or `media.publish-failed` after. A digest already
 * published is never re-sent; a failing digest is retried at most
 * {@link MEDIA_PUBLISH_MAX_ATTEMPTS} times, {@link MEDIA_PUBLISH_RETRY_MS}
 * apart, and then stays failed on the FOR YOU card. Rewriting the section is
 * idempotent, so a crash between attempt and outcome is repaired by the next
 * attempt.
 */

export const MEDIA_PUBLISH_ATTEMPT_EVENT = 'media.publish-attempt';
export const MEDIA_PUBLISHED_EVENT = 'media.published';
export const MEDIA_PUBLISH_FAILED_EVENT = 'media.publish-failed';
export const MEDIA_PUBLISH_MAX_ATTEMPTS = 3;
export const MEDIA_PUBLISH_RETRY_MS = 10 * 60_000;
/** Jobs published per tick: one description write can upload 80 MB. */
export const MEDIA_PUBLISH_MAX_JOBS_PER_TICK = 2;

export const MEDIA_SECTION_BEGIN = '<!-- gc-media:begin (written by Gru Command; edits inside are replaced) -->';
export const MEDIA_SECTION_END = '<!-- gc-media:end -->';
const BEGIN_PREFIX = '<!-- gc-media:begin';

const GH_VIEW_TIMEOUT_MS = 30_000;
const GH_EDIT_TIMEOUT_MS = 300_000;
const GITLAB_TIMEOUT_MS = 120_000;
const DETAIL_MAX_CHARS = 500;

// ------------------------------------------------------------------
// Pure helpers: digest, section render, body splice, attachment repair
// ------------------------------------------------------------------

/** What a publication carries: the head plus the exact captures (by id and
 * content hash), in capture order. */
export function mediaDigest(headSha: string, items: readonly MediaItem[]): string {
  const hash = createHash('sha256').update(`head ${headSha}\n`);
  for (const item of items) hash.update(`${item.id} ${item.sha256} ${item.role}\n`);
  return hash.digest('hex');
}

/** Markdown-inert caption text: every character markdown or HTML could act
 * on is escaped, so a caption can never become a link, an image, a heading,
 * a table cell or a comment that breaks the section markers. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>!|#{}~+=.-]/gu, (character) => `\\${character}`);
}

export interface SectionInput {
  readonly headSha: string;
  readonly items: readonly MediaItem[];
  /** The markdown target of each capture, by id (a local `./gc-media-N.ext`
   * reference for gh to rewrite, or a GitLab upload URL). */
  readonly targets: ReadonlyMap<string, string>;
}

/** The GC-owned section: a heading, the head it is bound to, then each
 * capture as a caption line and its image/player. Before shots first. */
export function renderMediaSection(input: SectionInput): string {
  const ordered = [...input.items].sort((left, right) =>
    (left.role === right.role ? 0 : left.role === 'before' ? -1 : 1) || left.seq - right.seq);
  const lines = [
    MEDIA_SECTION_BEGIN,
    '### What it looks like',
    '',
    `_Captured at \`${input.headSha.slice(0, 12)}\` (this PR's head) · ${ordered.length} file${ordered.length === 1 ? '' : 's'} · ` +
      'shown here by Gru Command and replaced when the head moves._',
  ];
  for (const item of ordered) {
    const target = input.targets.get(item.id);
    if (target === undefined) throw new Error(`no markdown target for capture ${item.id}`);
    const label = item.role === 'before' ? 'Before' : item.kind === 'video' ? 'Clip' : 'After';
    lines.push('', `**${label}:** ${escapeMarkdown(item.caption)}`, '', `![${escapeMarkdown(item.caption)}](${target})`);
  }
  lines.push('', MEDIA_SECTION_END);
  return lines.join('\n');
}

/** The description without GC's section. A begin marker with no end marker
 * is damage GC will not guess around: null, and the publication fails with
 * a reason a person can act on. */
export function stripMediaSection(body: string): string | null {
  const begin = body.indexOf(BEGIN_PREFIX);
  if (begin === -1) return body;
  const end = body.indexOf(MEDIA_SECTION_END, begin);
  if (end === -1) return null;
  const before = body.slice(0, begin).replace(/\s+$/u, '');
  const after = body.slice(end + MEDIA_SECTION_END.length).replace(/^\s+/u, '');
  if (after.includes(BEGIN_PREFIX)) return null; // two sections: damaged, never guessed
  return before === '' ? after : after === '' ? before : `${before}\n\n${after}`;
}

/** The description with the new section at its end. */
export function withMediaSection(stripped: string, section: string): string {
  const base = stripped.replace(/\s+$/u, '');
  return base === '' ? section : `${base}\n\n${section}`;
}

/** A line gh may have written for an uploaded attachment: an image or a bare
 * asset URL on GitHub's attachment hosts only — never a person's own link. */
const ATTACHMENT_URL = String.raw`https://(?:github\.com/user-attachments/|private-user-images\.githubusercontent\.com/|user-images\.githubusercontent\.com/)[^\s)"'<>]+`;
const ATTACHMENT_LINE = new RegExp(String.raw`^\s*(?:!\[[^\]\n]*\]\(${ATTACHMENT_URL}\)|${ATTACHMENT_URL}|<img\b[^>\n]*src="${ATTACHMENT_URL}"[^>\n]*>)\s*$`, 'u');
const LOCAL_REFERENCE = /!\[[^\]\n]*\]\(\.\/gc-media-\d+\.[a-z0-9]+\)/u;

/**
 * Repair the layout gh produced: an attachment it appended after the section
 * (instead of rewriting its `./gc-media-N` reference) is moved into the place
 * of the first reference still left unrewritten, in order; any extra appended
 * attachment line moves to the end of the section. Non-attachment text after
 * the section (a person's edit) is never moved.
 */
export function repairAttachmentLayout(body: string): string {
  const begin = body.indexOf(BEGIN_PREFIX);
  if (begin === -1) return body;
  const end = body.indexOf(MEDIA_SECTION_END, begin);
  if (end === -1) return body;
  const sectionLines = body.slice(begin, end).split('\n');
  const tailLines = body.slice(end + MEDIA_SECTION_END.length).split('\n');
  const appended: string[] = [];
  const keptTail: string[] = [];
  for (const line of tailLines) {
    if (ATTACHMENT_LINE.test(line)) appended.push(line.trim());
    else keptTail.push(line);
  }
  if (appended.length === 0) return body;
  for (let index = 0; index < sectionLines.length && appended.length > 0; index += 1) {
    if (LOCAL_REFERENCE.test(sectionLines[index]!)) sectionLines[index] = appended.shift()!;
  }
  while (sectionLines.length > 0 && sectionLines.at(-1)!.trim() === '') sectionLines.pop();
  if (appended.length > 0) sectionLines.push('', ...appended);
  sectionLines.push('');
  const tail = keptTail.join('\n').replace(/^\s+/u, '').replace(/\s+$/u, '');
  return `${body.slice(0, begin)}${sectionLines.join('\n')}${MEDIA_SECTION_END}${tail === '' ? '' : `\n\n${tail}`}`;
}

/** True when the section holds no reference gh failed to upload/rewrite. */
export function sectionFullyLinked(body: string): boolean {
  const begin = body.indexOf(BEGIN_PREFIX);
  const end = begin === -1 ? -1 : body.indexOf(MEDIA_SECTION_END, begin);
  if (begin === -1 || end === -1) return false;
  return !LOCAL_REFERENCE.test(body.slice(begin, end));
}

function bounded(text: string): string {
  return redactCredentials(text).replace(/[\r\n]+/gu, ' ').trim().slice(0, DETAIL_MAX_CHARS);
}

// ------------------------------------------------------------------
// Providers
// ------------------------------------------------------------------

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh` (argv only, never a shell). */
export type GhRunner = (args: readonly string[], opts: { readonly cwd?: string; readonly timeoutMs: number }) => Promise<CommandResult>;

export const runGh: GhRunner = (args, opts) =>
  new Promise((resolveRun) => {
    const child = spawn('gh', [...args], {
      cwd: opts.cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4_000_000) stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64_000) stderr += chunk.toString('utf-8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, stdout, stderr: signal === null ? stderr : `${stderr} (stopped by ${signal})` });
    });
  });

/** A publication's outcome: written, skipped for a reason that is not a
 * failure (the head moved, the change closed), or failed with a reason. */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly files: number }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly detail: string };

interface PublishRequest {
  readonly url: string;
  readonly headSha: string;
  readonly items: readonly MediaItem[];
  readonly dataDir: string;
  /** Journals the attempt; called right before the first irreversible write. */
  readonly beginWrite: () => void;
}

async function publishGitHub(request: PublishRequest, gh: GhRunner): Promise<PublishOutcome> {
  const view = async (): Promise<{ body: string; head: string; state: string } | string> => {
    const result = await gh(['pr', 'view', request.url, '--json', 'body,headRefOid,state'], { timeoutMs: GH_VIEW_TIMEOUT_MS });
    if (result.code !== 0) return `gh pr view failed (exit ${result.code}): ${result.stderr}`;
    try {
      const parsed = JSON.parse(result.stdout) as { body?: unknown; headRefOid?: unknown; state?: unknown };
      if (typeof parsed.body !== 'string' || typeof parsed.headRefOid !== 'string' || typeof parsed.state !== 'string') {
        return 'gh pr view answered without body, headRefOid or state';
      }
      return { body: parsed.body, head: parsed.headRefOid, state: parsed.state };
    } catch {
      return 'gh pr view answered with invalid JSON';
    }
  };
  const current = await view();
  if (typeof current === 'string') return { kind: 'failed', detail: current };
  if (current.state !== 'OPEN') return { kind: 'skipped', reason: `the pull request is ${current.state.toLowerCase()}` };
  if (current.head !== request.headSha) return { kind: 'skipped', reason: 'the pull request head moved since it was observed' };
  const stripped = stripMediaSection(current.body);
  if (stripped === null) {
    return { kind: 'failed', detail: 'the description has a damaged GC media section (a begin marker without its end, or two sections): delete the half-section by hand' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'gc-media-'));
  try {
    const targets = new Map<string, string>();
    const attach: string[] = [];
    request.items.forEach((item, index) => {
      const name = `gc-media-${index + 1}.${mediaExtension(item.mediaType)}`;
      writeFileSync(join(dir, name), readMediaBytes(request.dataDir, item), { mode: 0o600 });
      targets.set(item.id, `./${name}`);
      attach.push('--attach', `./${name}`);
    });
    const body = withMediaSection(stripped, renderMediaSection({ headSha: request.headSha, items: request.items, targets }));
    writeFileSync(join(dir, 'body.md'), body, { mode: 0o600 });
    request.beginWrite();
    const edit = await gh(['pr', 'edit', request.url, '--body-file', join(dir, 'body.md'), ...attach], { cwd: dir, timeoutMs: GH_EDIT_TIMEOUT_MS });
    if (edit.code !== 0) return { kind: 'failed', detail: `gh pr edit --attach failed (exit ${edit.code}): ${edit.stderr}` };
    const after = await view();
    if (typeof after === 'string') return { kind: 'failed', detail: `the description was written but could not be re-read: ${after}` };
    const repaired = repairAttachmentLayout(after.body);
    if (repaired !== after.body) {
      writeFileSync(join(dir, 'repaired.md'), repaired, { mode: 0o600 });
      const fix = await gh(['pr', 'edit', request.url, '--body-file', join(dir, 'repaired.md')], { cwd: dir, timeoutMs: GH_VIEW_TIMEOUT_MS });
      if (fix.code !== 0) return { kind: 'failed', detail: `moving gh's appended attachments into the GC section failed (exit ${fix.code}): ${fix.stderr}` };
    }
    if (!sectionFullyLinked(repaired)) {
      return { kind: 'failed', detail: 'gh left a capture unlinked in the GC section (an upload did not land)' };
    }
    return { kind: 'published', files: request.items.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GitLabPublishDeps {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

async function publishGitLab(request: PublishRequest, deps: GitLabPublishDeps): Promise<PublishOutcome> {
  const link = parseGitLabMrLink(request.url);
  if (link === null || link.kind !== 'supported' || !isGitLabMrHost(link.host)) {
    return { kind: 'failed', detail: 'the merge request is on a GitLab host this service does not send credentials to' };
  }
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  const token = env['GITLAB_TOKEN'] ?? env['GL_TOKEN'];
  if (token === undefined || token.trim() === '') {
    return { kind: 'failed', detail: 'GITLAB_TOKEN or GL_TOKEN is required to write the merge request description' };
  }
  const scrub = (text: string): string => bounded(text.split(token).join('[token]'));
  const base = `https://${link.host}/api/v4/projects/${encodeURIComponent(link.project)}`;
  const call = async (path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: string }> => {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'PRIVATE-TOKEN': token },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  };
  try {
    const read = await call(`/merge_requests/${link.iid}`, { method: 'GET' });
    if (!read.ok) return { kind: 'failed', detail: scrub(`reading the merge request answered HTTP ${read.status}: ${read.body.slice(0, 300)}`) };
    const mr = JSON.parse(read.body) as { description?: unknown; sha?: unknown; state?: unknown };
    if (mr.state !== 'opened') return { kind: 'skipped', reason: `the merge request is ${String(mr.state)}` };
    if (mr.sha !== request.headSha) return { kind: 'skipped', reason: 'the merge request head moved since it was observed' };
    const stripped = stripMediaSection(typeof mr.description === 'string' ? mr.description : '');
    if (stripped === null) {
      return { kind: 'failed', detail: 'the description has a damaged GC media section (a begin marker without its end, or two sections): delete the half-section by hand' };
    }
    request.beginWrite();
    const targets = new Map<string, string>();
    for (const [index, item] of request.items.entries()) {
      const form = new FormData();
      const bytes = readMediaBytes(request.dataDir, item);
      form.append('file', new Blob([bytes], { type: item.mediaType }), `gc-media-${index + 1}.${mediaExtension(item.mediaType)}`);
      const upload = await call('/uploads', { method: 'POST', body: form });
      if (!upload.ok) return { kind: 'failed', detail: scrub(`uploading a capture answered HTTP ${upload.status}: ${upload.body.slice(0, 300)}`) };
      const uploaded = JSON.parse(upload.body) as { url?: unknown };
      if (typeof uploaded.url !== 'string' || !/^\/(?:-\/project\/\d+\/)?uploads\/[^\s)]+$/u.test(uploaded.url)) {
        return { kind: 'failed', detail: 'GitLab answered an upload without a usable url' };
      }
      targets.set(item.id, uploaded.url);
    }
    const description = withMediaSection(stripped, renderMediaSection({ headSha: request.headSha, items: request.items, targets }));
    const update = await call(`/merge_requests/${link.iid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    if (!update.ok) return { kind: 'failed', detail: scrub(`updating the description answered HTTP ${update.status}: ${update.body.slice(0, 300)}`) };
    return { kind: 'published', files: request.items.length };
  } catch (error) {
    return { kind: 'failed', detail: scrub(String(error instanceof Error ? error.message : error)) };
  }
}

// ------------------------------------------------------------------
// The tick
// ------------------------------------------------------------------

export interface MediaPublisherLedger extends MediaLedger, BranchEvidenceLedger {
  listJobs(): readonly { readonly id: string; readonly status: string; readonly prUrl: string | null }[];
}

export interface MediaPublisherOptions {
  readonly ledger: MediaPublisherLedger;
  readonly dataDir: string;
  readonly config: () => PrMediaConfig;
  readonly gh?: GhRunner;
  readonly gitlab?: GitLabPublishDeps;
  readonly now?: () => number;
  readonly log?: Log;
}

export interface MediaPublishTickResult {
  readonly considered: number;
  readonly published: number;
  readonly failed: number;
  readonly skipped: number;
}

/** The publication status the FOR YOU card shows for the current captures. */
export type MediaPublicationView = OwnerPrMediaPublication;

/** True when the observation's change URL names the job's own PR/MR. */
function sameChange(prUrl: string, provider: 'github' | 'gitlab', changeUrl: string): boolean {
  if (provider === 'gitlab') {
    const link = parseGitLabMrLink(prUrl);
    return link !== null && link.kind === 'supported' &&
      changeUrl === `https://${link.host}/${link.project}/-/merge_requests/${link.iid}`;
  }
  const own = parseGitHubPrUrl(prUrl);
  const seen = parseGitHubPrUrl(changeUrl);
  return own !== null && seen !== null &&
    own.host.toLowerCase() === seen.host.toLowerCase() &&
    own.owner.toLowerCase() === seen.owner.toLowerCase() &&
    own.repo.toLowerCase() === seen.repo.toLowerCase() &&
    own.number === seen.number;
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

/** Failed attempts recorded for this exact digest, newest first. */
function failuresFor(ledger: MediaLedger, jobId: string, digest: string): readonly EventRecord[] {
  return ledger
    .listJobEvents(jobId, { kinds: [MEDIA_PUBLISH_FAILED_EVENT], order: 'desc', limit: 50 })
    .filter((event) => payloadOf(event)['digest'] === digest);
}

function publishedFor(ledger: MediaLedger, jobId: string, digest: string): EventRecord | null {
  return ledger
    .listJobEvents(jobId, { kinds: [MEDIA_PUBLISHED_EVENT], order: 'desc', limit: 50 })
    .find((event) => payloadOf(event)['digest'] === digest) ?? null;
}

/** Where the current captures stand on the PR/MR, for the board. */
export function mediaPublicationView(
  ledger: MediaLedger,
  jobId: string,
  headSha: string,
  items: readonly MediaItem[],
  config: PrMediaConfig,
): MediaPublicationView {
  if (config.publish === 'never') return { state: 'off', at: null, detail: null };
  const digest = mediaDigest(headSha, items);
  const published = publishedFor(ledger, jobId, digest);
  if (published !== null) return { state: 'published', at: published.ts, detail: null };
  const failures = failuresFor(ledger, jobId, digest);
  if (failures.length >= MEDIA_PUBLISH_MAX_ATTEMPTS) {
    const detail = payloadOf(failures[0]!)['detail'];
    return { state: 'failed', at: failures[0]!.ts, detail: typeof detail === 'string' ? detail : null };
  }
  return { state: 'pending', at: null, detail: null };
}

/** The FOR YOU card's media block for a ready row at `headSha`: the
 * captures bound to that head, the superseded count, and the publication
 * state. Null when the job has no captures at all. */
export function ownerPrMediaView(ledger: MediaLedger, jobId: string, headSha: string, config: PrMediaConfig): OwnerPrMediaView | null {
  if (!config.enabled) return null;
  const items = listMedia(ledger, jobId);
  if (items.length === 0) return null;
  const atHead = mediaAtHead(items, headSha);
  return {
    headSha,
    items: atHead.map((item) => ({
      id: item.id,
      kind: item.kind,
      mediaType: item.mediaType,
      role: item.role,
      caption: item.caption,
      bytes: item.bytes,
    })),
    superseded: items.length - atHead.length,
    publication: atHead.length === 0 ? null : mediaPublicationView(ledger, jobId, headSha, atHead, config),
  };
}

export class PrMediaPublisher {
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly options: MediaPublisherOptions) {
    this.gh = options.gh ?? runGh;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  async pollOnce(): Promise<MediaPublishTickResult> {
    const config = this.options.config();
    const result = { considered: 0, published: 0, failed: 0, skipped: 0 };
    if (!config.enabled || config.publish !== 'autonomous') return result;
    const ledger = this.options.ledger;
    const now = this.now();
    for (const job of ledger.listJobs()) {
      if (result.published + result.failed >= MEDIA_PUBLISH_MAX_JOBS_PER_TICK) break;
      if (job.prUrl === null || isTerminalJobStatus(job.status)) continue;
      const items = listMedia(ledger, job.id);
      if (items.length === 0) continue;
      const evidence = readOwnerEvidence(ledger, job, now);
      if (evidence === null || !evidence.open || evidence.merged || evidence.sha === '') continue;
      // The observation must describe THIS job's change: a head read for
      // another PR is never the head its captures are published against.
      if (!sameChange(job.prUrl, evidence.provider, evidence.changeUrl)) continue;
      const atHead = mediaAtHead(items, evidence.sha);
      if (atHead.length === 0) continue;
      const digest = mediaDigest(evidence.sha, atHead);
      if (publishedFor(ledger, job.id, digest) !== null) continue;
      const failures = failuresFor(ledger, job.id, digest);
      if (failures.length >= MEDIA_PUBLISH_MAX_ATTEMPTS) continue;
      const lastFailure = failures[0];
      if (lastFailure !== undefined && now - Date.parse(lastFailure.ts) < MEDIA_PUBLISH_RETRY_MS) continue;
      result.considered += 1;
      const request: PublishRequest = {
        url: job.prUrl,
        headSha: evidence.sha,
        items: atHead,
        dataDir: this.options.dataDir,
        beginWrite: () => {
          ledger.appendCustomEvent({
            kind: MEDIA_PUBLISH_ATTEMPT_EVENT,
            jobId: job.id,
            payload: { digest, head_sha: evidence.sha, provider: evidence.provider, url: job.prUrl, media_ids: atHead.map((item) => item.id) },
          });
        },
      };
      let outcome: PublishOutcome;
      try {
        outcome = evidence.provider === 'gitlab'
          ? await publishGitLab(request, this.options.gitlab ?? {})
          : await publishGitHub(request, this.gh);
      } catch (error) {
        outcome = { kind: 'failed', detail: String(error instanceof Error ? error.message : error) };
      }
      if (outcome.kind === 'published') {
        result.published += 1;
        ledger.appendCustomEvent({
          kind: MEDIA_PUBLISHED_EVENT,
          jobId: job.id,
          payload: { digest, head_sha: evidence.sha, provider: evidence.provider, url: job.prUrl, files: outcome.files },
        });
        this.log('info', 'pr media published', { job: job.id, head: evidence.sha, files: outcome.files });
      } else if (outcome.kind === 'failed') {
        result.failed += 1;
        const detail = bounded(outcome.detail);
        ledger.appendCustomEvent({
          kind: MEDIA_PUBLISH_FAILED_EVENT,
          jobId: job.id,
          payload: { digest, head_sha: evidence.sha, provider: evidence.provider, url: job.prUrl, attempt: failures.length + 1, detail },
        });
        this.log('warn', 'pr media publication failed', { job: job.id, head: evidence.sha, attempt: failures.length + 1, detail });
      } else {
        result.skipped += 1;
        this.log('info', 'pr media publication skipped', { job: job.id, reason: outcome.reason });
      }
    }
    return result;
  }
}
