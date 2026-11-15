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
import {
  listMedia,
  mediaAtHead,
  mediaExtension,
  mediaJobKey,
  readMediaBytes,
  storedMediaJobKeys,
  sweepJobMedia,
  type MediaItem,
  type MediaLedger,
} from './store.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The PR media publisher (owner rulings 2026-11-15: Q3 "PR body section,
 * replaced each head", Q5 "on by default, autonomous").
 *
 * Ticked after the GitHub/GitLab signal polls, on its own in-flight guard.
 * For each live job with an open PR/MR it keeps ONE GC-owned section of the
 * description current, between two marker lines:
 *
 *   - captures bound to the change's CURRENT observed head → the section
 *     shows them (before shots first);
 *   - the head moved and nothing is captured at it yet → the section is
 *     replaced by a short note saying the earlier captures are superseded,
 *     so the description never presents an older head's pixels as current.
 *
 * The section is replaced IN PLACE; every byte outside it stays as written.
 * Marker lines inside fenced code, or quoted inside prose, are not markers.
 *
 *   GitHub: `gh pr edit --body-file … --attach …` (gh ≥ 2.99; not GitHub
 *           Enterprise Server). The body names files `./gc-media-N.ext` in
 *           section order; gh rewrites them to the uploaded assets, and
 *           whatever gh appends instead (a video player has no alt text)
 *           is moved into the place of the reference it stands for. The
 *           result is re-read and must hold no unlinked reference; a
 *           partial upload is replaced by a "retrying" note, never left
 *           as broken images.
 *   GitLab: the project uploads API, then the description update (re-read
 *           just before the write, so an edit made during the uploads is
 *           kept), with the same `GITLAB_TOKEN`/`GL_TOKEN` the MR reads use.
 *
 * Durable truth on both sides of the write: `media.publish-attempt` before
 * it, `media.published` or `media.publish-failed` after, each carrying the
 * digest of exactly what was meant (change URL + head + captures). Only the
 * NEWEST publication for the job's current change counts as "on the PR", so
 * a head that returns, or a job re-pointed at another PR, is written again.
 * A failing digest gets {@link MEDIA_PUBLISH_MAX_ATTEMPTS} attempts,
 * {@link MEDIA_PUBLISH_RETRY_MS} apart; a precondition that cannot change by
 * retrying (Enterprise Server, a description over GitHub's limit) fails once.
 * Captures still arriving are left to settle for {@link MEDIA_PUBLISH_SETTLE_MS}
 * so a run of submissions is uploaded once. A person who deletes the
 * section is not overridden: it is written again only when the head or the
 * captures change.
 *
 * Closed jobs' local captures are deleted on the same tick (`media.swept`):
 * the PR keeps its published copies and the board shows only live jobs.
 */

export const MEDIA_PUBLISH_ATTEMPT_EVENT = 'media.publish-attempt';
export const MEDIA_PUBLISHED_EVENT = 'media.published';
export const MEDIA_PUBLISH_FAILED_EVENT = 'media.publish-failed';
export const MEDIA_PUBLISH_MAX_ATTEMPTS = 3;
export const MEDIA_PUBLISH_RETRY_MS = 10 * 60_000;
/** Newest capture at a head must be this old before the head is published. */
export const MEDIA_PUBLISH_SETTLE_MS = 2 * 60_000;
/** Changes contacted per tick (published, failed or skipped after a read). */
export const MEDIA_PUBLISH_MAX_JOBS_PER_TICK = 2;
/** GitHub's pull request body limit. */
export const GITHUB_BODY_MAX_CHARS = 65_536;
/** `gh pr edit --attach` arrived in gh 2.99. */
export const GH_ATTACH_MIN_VERSION: readonly [number, number, number] = [2, 99, 0];

export const MEDIA_SECTION_BEGIN = '<!-- gc-media:begin (written by Gru Command; edits inside are replaced) -->';
export const MEDIA_SECTION_END = '<!-- gc-media:end -->';

const GH_VIEW_TIMEOUT_MS = 30_000;
const GH_EDIT_TIMEOUT_MS = 300_000;
const GITLAB_TIMEOUT_MS = 120_000;
const DETAIL_MAX_CHARS = 500;

// ------------------------------------------------------------------
// Pure helpers: digest, section text, marker lines, attachment repair
// ------------------------------------------------------------------

/** What a media publication carries: the change, its head, and the exact
 * captures (by id, content hash and role), in section order. */
export function mediaDigest(changeUrl: string, headSha: string, items: readonly MediaItem[]): string {
  const hash = createHash('sha256').update(`media ${changeUrl}\nhead ${headSha}\n`);
  for (const item of items) hash.update(`${item.id} ${item.sha256} ${item.role}\n`);
  return hash.digest('hex');
}

/** What a superseded note carries: the change, the head it is written for,
 * and the head the last captures showed. */
export function supersededDigest(changeUrl: string, headSha: string, capturesHead: string): string {
  return createHash('sha256').update(`superseded ${changeUrl}\nhead ${headSha}\ncaptures ${capturesHead}\n`).digest('hex');
}

/** Markdown-inert caption text: every character markdown, HTML, GitHub or
 * GitLab could act on is escaped, so a caption can never become a link, an
 * image, a heading, a mention (`@user`, GitLab `%`/`&`/`$` references), an
 * autolink or emoji (`:`), or a comment that breaks the section markers. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>!|#{}~+=.\-@:%&$]/gu, (character) => `\\${character}`);
}

/** Before shots first, then capture order — the one order files are named,
 * attached and rendered in. */
export function orderForSection(items: readonly MediaItem[]): readonly MediaItem[] {
  return [...items].sort((left, right) =>
    (left.role === right.role ? 0 : left.role === 'before' ? -1 : 1) || left.seq - right.seq);
}

export type ChangeKind = 'PR' | 'MR';

export interface SectionInput {
  readonly headSha: string;
  /** Already in {@link orderForSection} order. */
  readonly items: readonly MediaItem[];
  /** The markdown target of each capture, by id. */
  readonly targets: ReadonlyMap<string, string>;
  readonly change: ChangeKind;
}

/** The GC-owned section showing captures. */
export function renderMediaSection(input: SectionInput): string {
  const lines = [
    MEDIA_SECTION_BEGIN,
    '### What it looks like',
    '',
    `_Captured at \`${input.headSha.slice(0, 12)}\` · ${input.items.length} file${input.items.length === 1 ? '' : 's'} · ` +
      `posted by Gru Command, which replaces this section when the ${input.change} head moves._`,
  ];
  for (const item of input.items) {
    const target = input.targets.get(item.id);
    if (target === undefined) throw new Error(`no markdown target for capture ${item.id}`);
    const label = item.role === 'before' ? 'Before' : item.kind === 'video' ? 'Clip' : 'After';
    lines.push('', `**${label}:** ${escapeMarkdown(item.caption)}`, '', `![${escapeMarkdown(item.caption)}](${target})`);
  }
  lines.push('', MEDIA_SECTION_END);
  return lines.join('\n');
}

/** A GC-owned section holding only a note (no media). */
export function renderNoticeSection(note: string): string {
  return [MEDIA_SECTION_BEGIN, '### What it looks like', '', `_${note}_`, '', MEDIA_SECTION_END].join('\n');
}

export function supersededNote(change: ChangeKind, capturesHead: string, headSha: string): string {
  return `The captures shown here earlier were taken at \`${capturesHead.slice(0, 12)}\`; this ${change} is now at ` +
    `\`${headSha.slice(0, 12)}\`. Gru Command replaces this note when the new head is captured.`;
}

export function uploadFailedNote(headSha: string, attempt: number): string {
  return attempt < MEDIA_PUBLISH_MAX_ATTEMPTS
    ? `Uploading the captures for \`${headSha.slice(0, 12)}\` did not complete; Gru Command will retry.`
    : `Uploading the captures for \`${headSha.slice(0, 12)}\` did not complete after ${MEDIA_PUBLISH_MAX_ATTEMPTS} attempts; they are on the Gru Command board.`;
}

interface LineSpan {
  readonly start: number;
  /** Offset just past the line's last character (before its newline). */
  readonly end: number;
}

/** The marker lines outside fenced code blocks. A marker counts only as a
 * whole line (surrounding spaces allowed), never quoted inside prose. */
function markerLines(body: string): { readonly begins: readonly LineSpan[]; readonly ends: readonly LineSpan[] } {
  const begins: LineSpan[] = [];
  const ends: LineSpan[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const raw of body.split('\n')) {
    const start = offset;
    const end = start + raw.length;
    offset = end + 1;
    const line = raw.replace(/\r$/u, '').trim();
    const fenceOpen = /^(`{3,}|~{3,})/u.exec(line);
    if (fence === null && fenceOpen !== null) {
      fence = fenceOpen[1]!;
      continue;
    }
    if (fence !== null) {
      // A closer is the opener's character repeated at least as many times.
      // (Backticks and tildes need no escaping in a pattern.)
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`, 'u').test(line)) fence = null;
      continue;
    }
    if (line === MEDIA_SECTION_BEGIN) begins.push({ start, end });
    else if (line === MEDIA_SECTION_END) ends.push({ start, end });
  }
  return { begins, ends };
}

/** The section's span (begin line start → end line end), null when there is
 * none, 'damaged' when the markers do not form exactly one section. */
export function findMediaSection(body: string): { readonly start: number; readonly end: number } | null | 'damaged' {
  const { begins, ends } = markerLines(body);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0]!.start < begins[0]!.end) return 'damaged';
  return { start: begins[0]!.start, end: ends[0]!.end };
}

/** The description with `section` in place of the existing one (every byte
 * outside it unchanged), or appended when there is none. Null = damaged
 * markers: GC never guesses which text is its own. */
export function spliceMediaSection(body: string, section: string): string | null {
  const span = findMediaSection(body);
  if (span === 'damaged') return null;
  if (span === null) {
    const base = body.replace(/\s+$/u, '');
    return base === '' ? section : `${base}\n\n${section}`;
  }
  return `${body.slice(0, span.start)}${section}${body.slice(span.end)}`;
}

/** A line gh may have written for an uploaded attachment: an image or a bare
 * asset URL on GitHub's attachment hosts only — never a person's own link. */
const ATTACHMENT_URL = String.raw`https://(?:github\.com/user-attachments/|private-user-images\.githubusercontent\.com/|user-images\.githubusercontent\.com/)[^\s)"'<>]+`;
const ATTACHMENT_LINE = new RegExp(String.raw`^\s*(?:!\[(?:\\.|[^\]\n])*\]\(${ATTACHMENT_URL}\)|${ATTACHMENT_URL}|<img\b[^>\n]*src="${ATTACHMENT_URL}"[^>\n]*>|<video\b[^>\n]*src="${ATTACHMENT_URL}"[^>\n]*>(?:</video>)?)\s*$`, 'u');
/** A `./gc-media-N.ext` reference gh did not rewrite (alt text may hold
 * escaped brackets, so only the target is matched). */
const LOCAL_REFERENCE = /\]\(\.\/gc-media-\d+\.[a-z0-9]+\)/u;

/**
 * Repair the layout gh produced: when references in the section were left
 * unrewritten, gh appended their attachments at the very end of the
 * description instead. Exactly that many lines are taken from the end of
 * the trailing run of attachment lines after the section — the last ones,
 * which gh wrote — and put in place of the unrewritten references, in
 * order. Anything else, including a person's own attachment placed after
 * the section, is left where it is.
 */
export function repairAttachmentLayout(body: string): string {
  const span = findMediaSection(body);
  if (span === null || span === 'damaged') return body;
  const sectionText = body.slice(span.start, span.end);
  const sectionLines = sectionText.split('\n');
  const unlinked = sectionLines.filter((line) => LOCAL_REFERENCE.test(line)).length;
  if (unlinked === 0) return body;
  const tailLines = body.slice(span.end).split('\n');
  let last = tailLines.length;
  while (last > 0 && tailLines[last - 1]!.trim() === '') last -= 1;
  const appended: string[] = [];
  let cut = last;
  while (cut > 0 && appended.length < unlinked && ATTACHMENT_LINE.test(tailLines[cut - 1]!)) {
    appended.unshift(tailLines[cut - 1]!.trim());
    cut -= 1;
  }
  if (appended.length === 0) return body;
  for (let index = 0; index < sectionLines.length && appended.length > 0; index += 1) {
    if (LOCAL_REFERENCE.test(sectionLines[index]!)) sectionLines[index] = appended.shift()!;
  }
  const tail = tailLines.slice(0, cut).join('\n').replace(/\s+$/u, '');
  return `${body.slice(0, span.start)}${sectionLines.join('\n')}${tail}`;
}

/** True when the description has exactly one section with no reference gh
 * failed to upload or rewrite. */
export function sectionFullyLinked(body: string): boolean {
  const span = findMediaSection(body);
  if (span === null || span === 'damaged') return false;
  return !LOCAL_REFERENCE.test(body.slice(span.start, span.end));
}

function bounded(text: string): string {
  return redactCredentials(text).replace(/[\r\n]+/gu, ' ').trim().slice(0, DETAIL_MAX_CHARS);
}

/** `gh version 2.101.0 (…)` → [2, 101, 0]; null when unparseable. */
export function parseGhVersion(output: string): readonly [number, number, number] | null {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/u.exec(output);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(found: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (found[index]! !== minimum[index]!) return found[index]! > minimum[index]!;
  }
  return true;
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
 * failure (the head moved, the change closed), or failed with a reason.
 * `final` failures cannot change by retrying and are not retried. */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly files: number }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly detail: string; readonly final?: boolean };

/** What one publication writes: the captures, or a note with no media. */
type PublishContent =
  | { readonly kind: 'media'; readonly items: readonly MediaItem[] }
  | { readonly kind: 'superseded'; readonly capturesHead: string };

interface PublishRequest {
  readonly url: string;
  readonly headSha: string;
  readonly content: PublishContent;
  readonly dataDir: string;
  /** This attempt's number for the digest (1-based). */
  readonly attempt: number;
  /** Journals the attempt; called right before the first irreversible write. */
  readonly beginWrite: () => void;
}

const DAMAGED = 'the description has a damaged GC media section (a marker line without its pair, or two sections): delete the stray gc-media marker lines by hand';

class GitHubWriter {
  private attachVerified = false;

  constructor(private readonly gh: GhRunner) {}

  /** gh ≥ 2.99 is a precondition of attaching files; checked once per
   * process (an older gh is re-checked on every attempt, so an upgrade is
   * picked up without a restart). */
  private async attachSupport(): Promise<string | null> {
    if (this.attachVerified) return null;
    const result = await this.gh(['--version'], { timeoutMs: GH_VIEW_TIMEOUT_MS });
    if (result.code !== 0) return `gh is not available to attach files (exit ${result.code}): ${result.stderr}`;
    const version = parseGhVersion(result.stdout);
    if (version === null) return `could not read the gh version from "${result.stdout.slice(0, 80)}"`;
    if (!versionAtLeast(version, GH_ATTACH_MIN_VERSION)) {
      return `PR media needs gh ${GH_ATTACH_MIN_VERSION.join('.')} or newer to attach files (found ${version.join('.')}); update gh`;
    }
    this.attachVerified = true;
    return null;
  }

  private async view(url: string): Promise<{ body: string; head: string; state: string } | string> {
    const result = await this.gh(['pr', 'view', url, '--json', 'body,headRefOid,state'], { timeoutMs: GH_VIEW_TIMEOUT_MS });
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
  }

  private async writeBody(url: string, dir: string, name: string, body: string, attach: readonly string[], timeoutMs: number): Promise<CommandResult> {
    writeFileSync(join(dir, name), body, { mode: 0o600 });
    return this.gh(['pr', 'edit', url, '--body-file', join(dir, name), ...attach], { cwd: dir, timeoutMs });
  }

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const link = parseGitHubPrUrl(request.url);
    if (link === null) return { kind: 'failed', detail: 'the job link is not a GitHub pull request URL', final: true };
    if (link.host.toLowerCase() !== 'github.com') {
      return { kind: 'failed', detail: `GitHub Enterprise Server (${link.host}) does not support gh --attach: PR media stays on the board for this repository`, final: true };
    }
    if (request.content.kind === 'media') {
      const unsupported = await this.attachSupport();
      if (unsupported !== null) return { kind: 'failed', detail: unsupported };
    }
    const current = await this.view(request.url);
    if (typeof current === 'string') return { kind: 'failed', detail: current };
    if (current.state !== 'OPEN') return { kind: 'skipped', reason: `the pull request is ${current.state.toLowerCase()}` };
    if (current.head !== request.headSha) return { kind: 'skipped', reason: 'the pull request head moved since it was observed' };
    const dir = mkdtempSync(join(tmpdir(), 'gc-media-'));
    try {
      if (request.content.kind === 'superseded') {
        const body = spliceMediaSection(current.body, renderNoticeSection(supersededNote('PR', request.content.capturesHead, request.headSha)));
        if (body === null) return { kind: 'failed', detail: DAMAGED };
        request.beginWrite();
        const edit = await this.writeBody(request.url, dir, 'body.md', body, [], GH_VIEW_TIMEOUT_MS);
        if (edit.code !== 0) return { kind: 'failed', detail: `gh pr edit failed (exit ${edit.code}): ${edit.stderr}` };
        return { kind: 'published', files: 0 };
      }
      const items = request.content.items;
      const targets = new Map<string, string>();
      const attach: string[] = [];
      items.forEach((item, index) => {
        const name = `gc-media-${index + 1}.${mediaExtension(item.mediaType)}`;
        writeFileSync(join(dir, name), readMediaBytes(request.dataDir, item), { mode: 0o600 });
        targets.set(item.id, `./${name}`);
        attach.push('--attach', `./${name}`);
      });
      const body = spliceMediaSection(current.body, renderMediaSection({ headSha: request.headSha, items, targets, change: 'PR' }));
      if (body === null) return { kind: 'failed', detail: DAMAGED };
      if (body.length > GITHUB_BODY_MAX_CHARS) {
        return { kind: 'failed', detail: `the description would exceed GitHub's ${GITHUB_BODY_MAX_CHARS}-character limit with the media section: shorten it` };
      }
      request.beginWrite();
      const edit = await this.writeBody(request.url, dir, 'body.md', body, attach, GH_EDIT_TIMEOUT_MS);
      const after = await this.view(request.url);
      if (edit.code !== 0) {
        await this.replaceBroken(request, dir, after);
        return { kind: 'failed', detail: `gh pr edit --attach failed (exit ${edit.code}): ${edit.stderr}` };
      }
      if (typeof after === 'string') return { kind: 'failed', detail: `the description was written but could not be re-read: ${after}` };
      const repaired = repairAttachmentLayout(after.body);
      if (repaired !== after.body) {
        const fix = await this.writeBody(request.url, dir, 'repaired.md', repaired, [], GH_VIEW_TIMEOUT_MS);
        if (fix.code !== 0) {
          return { kind: 'failed', detail: `moving gh's appended attachments into the GC section failed (exit ${fix.code}): ${fix.stderr}` };
        }
      }
      if (!sectionFullyLinked(repaired)) {
        await this.replaceBroken(request, dir, { ...after, body: repaired });
        return { kind: 'failed', detail: 'gh left a capture unlinked in the GC section (an upload did not land)' };
      }
      return { kind: 'published', files: items.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** After a partial upload, never leave broken `./gc-media-N` images in
   * the description: replace an unlinked section with a "retrying" note. */
  private async replaceBroken(request: PublishRequest, dir: string, after: { body: string } | string): Promise<void> {
    if (typeof after === 'string' || sectionFullyLinked(after.body) || findMediaSection(after.body) === null) return;
    const body = spliceMediaSection(after.body, renderNoticeSection(uploadFailedNote(request.headSha, request.attempt)));
    if (body !== null) await this.writeBody(request.url, dir, 'notice.md', body, [], GH_VIEW_TIMEOUT_MS);
  }
}

export interface GitLabPublishDeps {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

async function publishGitLab(request: PublishRequest, deps: GitLabPublishDeps): Promise<PublishOutcome> {
  const link = parseGitLabMrLink(request.url);
  if (link === null || link.kind !== 'supported' || !isGitLabMrHost(link.host)) {
    return { kind: 'failed', detail: 'the merge request is on a GitLab host this service does not send credentials to', final: true };
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
    // `redirect: 'manual'`: the credential is never forwarded to a redirect target.
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'PRIVATE-TOKEN': token },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  };
  const readMr = async (): Promise<{ description: string; sha: unknown; state: unknown } | string> => {
    const read = await call(`/merge_requests/${link.iid}`, { method: 'GET' });
    if (!read.ok) return `reading the merge request answered HTTP ${read.status}: ${read.body.slice(0, 300)}`;
    const mr = JSON.parse(read.body) as { description?: unknown; sha?: unknown; state?: unknown };
    return { description: typeof mr.description === 'string' ? mr.description : '', sha: mr.sha, state: mr.state };
  };
  try {
    const mr = await readMr();
    if (typeof mr === 'string') return { kind: 'failed', detail: scrub(mr) };
    if (mr.state !== 'opened') return { kind: 'skipped', reason: `the merge request is ${String(mr.state)}` };
    if (mr.sha !== request.headSha) return { kind: 'skipped', reason: 'the merge request head moved since it was observed' };
    if (findMediaSection(mr.description) === 'damaged') return { kind: 'failed', detail: DAMAGED };
    let section: string;
    let files = 0;
    request.beginWrite();
    if (request.content.kind === 'superseded') {
      section = renderNoticeSection(supersededNote('MR', request.content.capturesHead, request.headSha));
    } else {
      const items = request.content.items;
      const targets = new Map<string, string>();
      for (const [index, item] of items.entries()) {
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
      section = renderMediaSection({ headSha: request.headSha, items, targets, change: 'MR' });
      files = items.length;
    }
    // Re-read just before writing: an edit made during the uploads is kept.
    const fresh = await readMr();
    if (typeof fresh === 'string') return { kind: 'failed', detail: scrub(fresh) };
    if (fresh.sha !== request.headSha) return { kind: 'failed', detail: 'the merge request head moved during the uploads' };
    const description = spliceMediaSection(fresh.description, section);
    if (description === null) return { kind: 'failed', detail: DAMAGED };
    const update = await call(`/merge_requests/${link.iid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    if (!update.ok) return { kind: 'failed', detail: scrub(`updating the description answered HTTP ${update.status}: ${update.body.slice(0, 300)}`) };
    return { kind: 'published', files };
  } catch (error) {
    return { kind: 'failed', detail: scrub(String(error instanceof Error ? error.message : error)) };
  }
}

// ------------------------------------------------------------------
// Ledger reads and the FOR YOU projection
// ------------------------------------------------------------------

/** The publication status the FOR YOU card shows for the current captures. */
export type MediaPublicationView = OwnerPrMediaPublication;

function payloadOf(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

/** The newest publication written to THIS change (a job re-pointed at
 * another PR starts over). */
function latestPublishedFor(ledger: MediaLedger, jobId: string, changeUrl: string): EventRecord | null {
  return ledger
    .listJobEvents(jobId, { kinds: [MEDIA_PUBLISHED_EVENT], order: 'desc', limit: 50 })
    .find((event) => payloadOf(event)['url'] === changeUrl) ?? null;
}

/** Failed attempts recorded for this exact digest, newest first. */
function failuresFor(ledger: MediaLedger, jobId: string, digest: string): readonly EventRecord[] {
  return ledger
    .listJobEvents(jobId, { kinds: [MEDIA_PUBLISH_FAILED_EVENT], order: 'desc', limit: 50 })
    .filter((event) => payloadOf(event)['digest'] === digest);
}

function exhausted(failures: readonly EventRecord[]): boolean {
  return failures.length >= MEDIA_PUBLISH_MAX_ATTEMPTS || failures.some((event) => payloadOf(event)['final'] === true);
}

/** The head the newest publication's captures showed (a superseded note
 * carries it forward). */
function capturesHeadOf(event: EventRecord): string | null {
  const payload = payloadOf(event);
  const head = payload['kind'] === 'superseded' ? payload['captures_head'] : payload['head_sha'];
  return typeof head === 'string' ? head : null;
}

/** Where the current captures stand on the PR/MR, for the board. */
export function mediaPublicationView(
  ledger: MediaLedger,
  input: { readonly jobId: string; readonly changeUrl: string; readonly headSha: string; readonly items: readonly MediaItem[] },
  config: PrMediaConfig,
  publishing: boolean,
): MediaPublicationView {
  if (config.publish === 'never') return { state: 'off', at: null, detail: null };
  if (!publishing) {
    return { state: 'off', at: null, detail: 'publishing runs on the Silas signal poll, which is off on this instance' };
  }
  const digest = mediaDigest(input.changeUrl, input.headSha, orderForSection(input.items));
  const published = latestPublishedFor(ledger, input.jobId, input.changeUrl);
  if (published !== null && payloadOf(published)['digest'] === digest) return { state: 'published', at: published.ts, detail: null };
  const failures = failuresFor(ledger, input.jobId, digest);
  const reason = failures.length === 0 ? null : payloadOf(failures[0]!)['detail'];
  const detail = typeof reason === 'string' ? reason : null;
  if (exhausted(failures)) return { state: 'failed', at: failures[0]!.ts, detail };
  if (failures.length > 0) {
    return { state: 'pending', at: failures[0]!.ts, detail: `attempt ${failures.length} of ${MEDIA_PUBLISH_MAX_ATTEMPTS} failed: ${detail ?? 'see the service log'}` };
  }
  return { state: 'pending', at: null, detail: null };
}

/** The FOR YOU card's media block for a ready row at `headSha`: the
 * captures bound to that head, the superseded count, and the publication
 * state. Null when the job has no captures at all. */
export function ownerPrMediaView(
  ledger: MediaLedger,
  row: { readonly jobId: string; readonly prUrl: string; readonly sha: string },
  config: PrMediaConfig,
  publishing: boolean,
): OwnerPrMediaView | null {
  if (!config.enabled) return null;
  const items = listMedia(ledger, row.jobId);
  if (items.length === 0) return null;
  const atHead = orderForSection(mediaAtHead(items, row.sha));
  return {
    headSha: row.sha,
    items: atHead.map((item) => ({
      id: item.id,
      kind: item.kind,
      mediaType: item.mediaType,
      role: item.role,
      caption: item.caption,
      bytes: item.bytes,
    })),
    superseded: items.length - atHead.length,
    publication: atHead.length === 0
      ? null
      : mediaPublicationView(ledger, { jobId: row.jobId, changeUrl: row.prUrl, headSha: row.sha, items: atHead }, config, publishing),
  };
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
  readonly swept: number;
}

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

export class PrMediaPublisher {
  private readonly github: GitHubWriter;
  private readonly now: () => number;
  private readonly log: Log;

  constructor(private readonly options: MediaPublisherOptions) {
    this.github = new GitHubWriter(options.gh ?? runGh);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Delete closed jobs' local captures (the PR keeps its published copies). */
  private sweepClosed(jobs: readonly { readonly id: string; readonly status: string }[]): number {
    const stored = storedMediaJobKeys(this.options.dataDir);
    if (stored.size === 0) return 0;
    let swept = 0;
    for (const job of jobs) {
      if (!isTerminalJobStatus(job.status) || !stored.has(mediaJobKey(job.id))) continue;
      const result = sweepJobMedia(this.options.dataDir, this.options.ledger, job.id);
      if (result === null) continue;
      swept += 1;
      this.log('info', 'pr media swept for a closed job', { job: job.id, files: result.files, bytes: result.bytes });
    }
    return swept;
  }

  async pollOnce(): Promise<MediaPublishTickResult> {
    const config = this.options.config();
    const ledger = this.options.ledger;
    const jobs = ledger.listJobs();
    const result = { considered: 0, published: 0, failed: 0, skipped: 0, swept: this.sweepClosed(jobs) };
    if (!config.enabled || config.publish !== 'autonomous') return result;
    const now = this.now();
    for (const job of jobs) {
      if (result.considered >= MEDIA_PUBLISH_MAX_JOBS_PER_TICK) break;
      const prUrl = job.prUrl;
      if (prUrl === null || isTerminalJobStatus(job.status)) continue;
      const items = listMedia(ledger, job.id);
      if (items.length === 0) continue;
      const evidence = readOwnerEvidence(ledger, { id: job.id, prUrl }, now);
      if (evidence === null || !evidence.open || evidence.merged || evidence.sha === '') continue;
      // The observation must describe THIS job's change: a head read for
      // another PR is never the head its captures are published against.
      if (!sameChange(prUrl, evidence.provider, evidence.changeUrl)) continue;
      const head = evidence.sha;
      const atHead = orderForSection(mediaAtHead(items, head));
      const latest = latestPublishedFor(ledger, job.id, prUrl);
      let content: PublishContent;
      let digest: string;
      if (atHead.length > 0) {
        // Let a run of submissions settle so it is uploaded once.
        const newest = Math.max(...atHead.map((item) => Date.parse(item.recordedAt)));
        if (now - newest < MEDIA_PUBLISH_SETTLE_MS) continue;
        content = { kind: 'media', items: atHead };
        digest = mediaDigest(prUrl, head, atHead);
      } else {
        // Nothing captured at the new head: once something was published
        // for an older head, say so instead of leaving it looking current.
        const capturesHead = latest === null ? null : capturesHeadOf(latest);
        if (latest === null || capturesHead === null || payloadOf(latest)['head_sha'] === head) continue;
        content = { kind: 'superseded', capturesHead };
        digest = supersededDigest(prUrl, head, capturesHead);
      }
      if (latest !== null && payloadOf(latest)['digest'] === digest) continue;
      const failures = failuresFor(ledger, job.id, digest);
      if (exhausted(failures)) continue;
      const lastFailure = failures[0];
      if (lastFailure !== undefined && now - Date.parse(lastFailure.ts) < MEDIA_PUBLISH_RETRY_MS) continue;
      result.considered += 1;
      const base = {
        digest,
        kind: content.kind,
        head_sha: head,
        provider: evidence.provider,
        url: prUrl,
        ...(content.kind === 'media'
          ? { media_ids: content.items.map((item) => item.id) }
          : { captures_head: content.capturesHead }),
      };
      const request: PublishRequest = {
        url: prUrl,
        headSha: head,
        content,
        dataDir: this.options.dataDir,
        attempt: failures.length + 1,
        beginWrite: () => {
          ledger.appendCustomEvent({ kind: MEDIA_PUBLISH_ATTEMPT_EVENT, jobId: job.id, payload: base });
        },
      };
      let outcome: PublishOutcome;
      try {
        outcome = evidence.provider === 'gitlab'
          ? await publishGitLab(request, this.options.gitlab ?? {})
          : await this.github.publish(request);
      } catch (error) {
        outcome = { kind: 'failed', detail: String(error instanceof Error ? error.message : error) };
      }
      if (outcome.kind === 'published') {
        result.published += 1;
        ledger.appendCustomEvent({ kind: MEDIA_PUBLISHED_EVENT, jobId: job.id, payload: { ...base, files: outcome.files } });
        this.log('info', 'pr media published', { job: job.id, head, kind: content.kind, files: outcome.files });
      } else if (outcome.kind === 'failed') {
        result.failed += 1;
        const detail = bounded(outcome.detail);
        ledger.appendCustomEvent({
          kind: MEDIA_PUBLISH_FAILED_EVENT,
          jobId: job.id,
          payload: { ...base, attempt: failures.length + 1, detail, ...(outcome.final === true ? { final: true } : {}) },
        });
        this.log('warn', 'pr media publication failed', { job: job.id, head, attempt: failures.length + 1, detail });
      } else {
        result.skipped += 1;
        this.log('info', 'pr media publication skipped', { job: job.id, reason: outcome.reason });
      }
    }
    return result;
  }
}
