import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { devNull } from 'node:os';
import { defaultGhRunner, ghApiJson, GhRateLimitedError, type GhCommandRunner } from '../dispatch/github-poll.js';
import { isGitHubRemote, repoRemote, type RepoRemote } from '../dispatch/review-path.js';
import { readServiceUploadIdentity } from '../review-inputs/evidence.js';
import { digest, IntakeError, type Capture, type DocumentInput, type Gap, type IntakeSource, type Snapshot } from './types.js';

export const INTAKE_MAX_SOURCE_BYTES = 256 * 1024;
export const INTAKE_MAX_DOCUMENTS = 8;
export const INTAKE_MAX_AGGREGATE_BYTES = 1024 * 1024;
export const INTAKE_MAX_REQUIREMENTS = 4000;
export interface SourcePorts {
  readonly uploadsDir: string;
  readonly ghRunner?: GhCommandRunner;
  readonly remote?: (repoPath: string) => RepoRemote | null;
}
function fail(code: string, message: string): never { throw new IntakeError(code, message); }
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function safeRelative(value: string): string {
  if (value === '' || isAbsolute(value) || /[\\:\p{Cc}]/u.test(value) || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('intake_unsafe_path', 'documents must use exact repository-relative paths without traversal');
  }
  return value;
}
/** Check all components, no-follow open, inode/size/time checks and a bounded
 * descriptor read. Imported paths and file contents never become instructions. */
function documentBytes(root: string, path: string): string {
  if (!contained(root, path)) fail('intake_unsafe_path', 'document escapes the allowed source root');
  let cursor = parse(path).root;
  const components: { readonly path: string; readonly ino: bigint; readonly dev: bigint }[] = [];
  for (const component of relative(cursor, path).split(sep)) {
    cursor = join(cursor, component);
    const info = lstatSync(cursor, { bigint: true });
    if (cursor !== path) components.push({ path: cursor, ino: info.ino, dev: info.dev });
    if (info.isSymbolicLink() || (cursor !== path && !info.isDirectory())) fail('intake_unsafe_path', 'source path components must be real directories without symlinks');
    if ((cursor === root || contained(root, cursor)) && !readdirSync(dirname(cursor)).includes(basename(cursor))) {
      fail('intake_unsafe_path', 'source path must use the exact filesystem spelling');
    }
  }
  const checkComponents = (): void => {
    for (const component of components) {
      const current = lstatSync(component.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== component.ino || current.dev !== component.dev) fail('intake_source_changed', 'source directory identity changed during capture');
    }
    if (realpathSync(path) !== path) fail('intake_unsafe_path', 'source path is not canonical inside its allowed root');
  };
  checkComponents();
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail('intake_unsafe_path', 'source must be a regular file without hardlinks');
  if (before.size === 0n || before.size > BigInt(INTAKE_MAX_SOURCE_BYTES)) fail('intake_source_bounds', 'source must be nonempty and at most 256 KiB');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.ino !== before.ino || opened.dev !== before.dev) fail('intake_source_changed', 'source identity changed while opening');
    const buffer = Buffer.alloc(INTAKE_MAX_SOURCE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    checkComponents();
    if (size > INTAKE_MAX_SOURCE_BYTES || BigInt(size) !== before.size || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1n) {
      fail('intake_source_changed', 'source changed during capture; retry with a new request');
    }
    try {
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
      if (raw.includes('\0')) fail('intake_malformed_document', 'source contains NUL bytes');
      return raw;
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      fail('intake_malformed_document', 'source is not valid UTF-8');
    }
  } finally { closeSync(fd); }
}
function documentLocation(repo: string, input: DocumentInput, uploadsDir: string): { readonly root: string; readonly path: string; readonly locator: string } {
  if (input.path !== undefined) {
    const path = safeRelative(input.path);
    return { root: repo, path: join(repo, path), locator: path };
  }
  const identity = readServiceUploadIdentity(uploadsDir, input.uploadPath!);
  return { root: resolve(uploadsDir), path: identity.path, locator: `upload:${identity.name}` };
}
/** A deliberately narrow scalar subset, not YAML execution/schema authority. */
function frontmatter(raw: string): { readonly frontmatter: string | null; readonly identifiers: Readonly<Record<string, string>>; readonly malformed: boolean; readonly questions: readonly string[] } {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = raw.slice(bom.length);
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { frontmatter: null, identifiers: {}, malformed: false, questions: [] };
  const match = /^---\r?\n([\s\S]*?)^---(?:\r?\n|(?![\s\S]))/mu.exec(text);
  if (match === null) return { frontmatter: raw, identifiers: {}, malformed: true, questions: [] };
  const identifiers: Record<string, string> = {};
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  let active: string | null = null;
  for (const [line] of match[1]!.matchAll(/[^\r\n]+/gu)) {
    const field = /^([ \t]*)(id|epic|epic_id|story|story_id|title|status)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (field === null) {
      if (active !== null && /^[ \t]+\S/u.test(line)) ambiguous.add(active);
      if (/^\S/u.test(line)) active = null;
      continue;
    }
    const key = field[2]!;
    const scalar = field[3]!.trim();
    active = key;
    if (seen.has(key) || field[1] !== '') ambiguous.add(key);
    seen.add(key);
    let value: string | null = null;
    if (/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/u.test(scalar) && !/^(?:true|false|null)$/iu.test(scalar)) value = scalar;
    else if (/^'[^'\r\n]+'$/u.test(scalar) || /^"[^"\\\r\n]+"$/u.test(scalar)) value = scalar.slice(1, -1);
    if (value === null) ambiguous.add(key);
    else identifiers[key] = value;
  }
  for (const key of ambiguous) delete identifiers[key];
  return {
    frontmatter: `${bom}${match[0]}`, identifiers, malformed: false,
    questions: [...ambiguous].map((key) => `Identifying metadata ${key} is malformed, duplicated or outside the supported unambiguous scalar subset; clarify it explicitly. Exact header bytes are retained, no value is guessed.`),
  };
}

/** Mask code only for Markdown reference recognition. Snapshot/inventory
 * bytes and offsets always use the unmodified source, never this view. */
function markdownReferenceText(raw: string): string {
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let fence: { readonly marker: string; readonly start: number } | null = null;
  for (const match of raw.matchAll(/^[ ]{0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gmu)) {
    const marker = match[1]!;
    const tail = match[2]!;
    if (fence === null) {
      if (marker[0] === '`' && tail.includes('`')) continue;
      fence = { marker, start: match.index };
    } else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && tail.trim() === '') {
      ranges.push({ start: fence.start, end: match.index + match[0].length });
      fence = null;
    }
  }
  if (fence !== null) ranges.push({ start: fence.start, end: raw.length });
  const mask = (text: string, spans: typeof ranges): string => {
    let cursor = 0;
    const parts: string[] = [];
    for (const { start, end } of spans) {
      parts.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, ' '));
      cursor = end;
    }
    parts.push(text.slice(cursor));
    return parts.join('');
  };
  const fenced = mask(raw, ranges);
  const inline: typeof ranges = [];
  let opener: { readonly length: number; readonly start: number; readonly end: number } | null = null;
  for (const match of fenced.matchAll(/`+/gu)) {
    if (opener !== null && /\r?\n[ \t]*\r?\n/u.test(fenced.slice(opener.end, match.index))) opener = null;
    if (opener === null) {
      let escapes = 0;
      for (let index = match.index - 1; index >= 0 && fenced[index] === '\\'; index--) escapes++;
      const escaped = escapes % 2;
      if (match[0].length === escaped) continue;
      opener = { length: match[0].length - escaped, start: match.index + escaped, end: match.index + match[0].length };
    } else if (match[0].length === opener.length) {
      inline.push({ start: opener.start, end: match.index + match[0].length });
      opener = null;
    }
  }
  return mask(fenced, inline);
}

function storyPath(target: string, locator: string): string {
  const encoded = target.split('#')[0]!;
  let path: string;
  try {
    path = decodeURIComponent(encoded);
    for (const segment of encoded.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (decoded !== segment && (decoded === '.' || decoded === '..' || /[/\\]/u.test(decoded))) {
        fail('intake_unsafe_story_reference', 'encoded traversal or path separators are not supported story destinations');
      }
    }
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    fail('intake_unsafe_story_reference', 'story destination has malformed percent encoding');
  }
  if (isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) || /[\\?\p{Cc}]/u.test(path) || locator.startsWith('upload:')) {
    fail('intake_unsafe_story_reference', 'story destination must stay inside the explicitly selected repository, not a foreign path/host');
  }
  const candidate = join(dirname(locator), path).split(sep).join('/');
  if (candidate === '..' || candidate.startsWith('../')) fail('intake_unsafe_story_reference', 'story destination escapes the selected repository');
  return candidate;
}

/** Ordinary inline/full/collapsed/shortcut references only. Recognizing a
 * destination does not authorize reading it; fragment/title text stays data. */
function storyReferences(raw: string): readonly { readonly label: string; readonly target: string | null }[] {
  const text = markdownReferenceText(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
  const normalize = (label: string): string => label.trim().replace(/\s+/gu, ' ').toLowerCase();
  const definitions = new Map<string, string | null>();
  for (const [, label, angled, plain] of text.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gmu)) {
    const key = normalize(label!);
    definitions.set(key, definitions.has(key) ? null : (angled ?? plain)!);
  }
  const references: { label: string; target: string | null }[] = [];
  for (const [, label, angled, plain] of text.matchAll(/(?<!!)\[([^\]\n]*)\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)/gu)) {
    references.push({ label: label!, target: (angled ?? plain)! });
  }
  for (const [, label, reference] of text.matchAll(/(?<!!)\[([^\]\n]+)\][ \t]*\[([^\]\n]*)\]/gu)) {
    references.push({ label: `${label} ${reference}`, target: definitions.get(normalize(reference || label!)) ?? null });
  }
  for (const match of text.matchAll(/(?<!!|\])\[([^\]\n]+)\](?![ \t]*[[(:])/gu)) {
    if (/\][ \t]*$/u.test(text.slice(0, match.index))) continue;
    const label = match[1]!;
    references.push({ label, target: definitions.get(normalize(label)) ?? null });
  }
  return references.filter(({ label, target }) => {
    if (!/story|stories/iu.test(`${label} ${target ?? ''}`)) return false;
    if (target === null) return true;
    try {
      const path = decodeURIComponent(target.split('#')[0]!);
      return /\.md$/iu.test(path) || isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path);
    } catch { return true; } // malformed references must remain visible questions
  });
}
function issueCoordinates(reference: string, remote: RepoRemote | null): { readonly host: string; readonly owner: string; readonly repo: string; readonly number: number; readonly url: string } {
  if (remote === null || !isGitHubRemote(remote.host) || !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) || !/^[A-Za-z0-9_.-]+$/u.test(remote.repo) || /[:/@\s]/u.test(remote.host)) {
    fail('intake_issue_host', 'target repository needs a supported GitHub origin');
  }
  let number: number;
  const explicit = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9]\d*)$/u.exec(reference);
  if (explicit !== null) {
    if (explicit[1] !== undefined && (explicit[1] !== remote.owner || explicit[2] !== remote.repo)) fail('intake_issue_identity', 'issue reference must belong to the selected repository');
    number = Number(explicit[3]);
  } else {
    let url: URL;
    try { url = new URL(reference); } catch { return fail('intake_issue_reference', 'use #number, owner/repo#number or an exact HTTPS issue URL'); }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/u.exec(url.pathname);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '' ||
        match === null || url.hostname !== remote.host || match[1] !== remote.owner || match[2] !== remote.repo || reference !== `https://${remote.host}${url.pathname}`) {
      fail('intake_issue_reference', 'issue URL must be exact HTTPS on the target origin, without credentials, port, query or fragment');
    }
    number = Number(match[3]);
  }
  if (!Number.isSafeInteger(number)) fail('intake_issue_reference', 'issue number must be a positive safe integer');
  return { ...remote, number, url: `https://${remote.host}/${remote.owner}/${remote.repo}/issues/${number}` };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('intake_malformed_issue', 'GitHub response must be an issue object');
  return value as Record<string, unknown>;
}
function gap(error: unknown, locator: string): Gap {
  const code = error instanceof IntakeError ? error.code : error instanceof Error && error.name !== 'Error' ? error.name : 'intake_source_unavailable';
  return { code, locator, question: `${code}: ${error instanceof Error ? error.message : String(error)}. Supply or clarify this source explicitly.` };
}

export async function captureSources(repo: string, source: IntakeSource, ports: SourcePorts): Promise<Capture> {
  const snapshots: Snapshot[] = [];
  const gaps: Gap[] = [];
  const gapIdentities = new Set<string>();
  const addGap = (value: Gap): void => {
    const identity = JSON.stringify([value.code, value.locator, value.question]);
    if (!gapIdentities.has(identity)) { gapIdentities.add(identity); gaps.push(value); }
  };
  if (source.kind === 'issue') {
    let coordinates: ReturnType<typeof issueCoordinates>;
    try {
      const remote = ports.remote === undefined
        ? repoRemote(repo, 'git', { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' })
        : ports.remote(repo);
      coordinates = issueCoordinates(source.reference, remote);
    }
    catch (error) { return { snapshots, gaps: [gap(error, source.reference)], requirements: [] }; }
    const run = ports.ghRunner ?? defaultGhRunner('gh', { maxOutputBytes: INTAKE_MAX_SOURCE_BYTES, maxStderrBytes: 4096, strictUtf8: true });
    let rateLimited = false;
    const capture = async (path: string, locator: string, kind: 'issue' | 'comment', expectedId?: number): Promise<void> => {
      let raw = '';
      try {
        const parsed = record(await ghApiJson(async (args) => {
          const response = await run(args);
          raw = response.stdout;
          if (Buffer.byteLength(raw) > INTAKE_MAX_SOURCE_BYTES) fail('intake_source_bounds', 'issue response exceeds 256 KiB');
          // Strip a BOM only from the JSON parser view; raw/hash retain its bytes.
          return { ...response, stdout: response.stdout.startsWith('\uFEFF') ? response.stdout.slice(1) : response.stdout };
        }, 'gh', 'intake issue capture', coordinates.host, path));
        if (kind === 'issue' && (parsed['number'] !== coordinates.number || parsed['html_url'] !== coordinates.url || parsed['pull_request'] !== undefined)) fail('intake_issue_identity', 'GitHub response is a different issue or a pull request');
        if (kind === 'comment' && (parsed['id'] !== expectedId || parsed['issue_url'] !== `https://${coordinates.host === 'github.com' ? 'api.github.com' : `${coordinates.host}/api/v3`}/repos/${coordinates.owner}/${coordinates.repo}/issues/${coordinates.number}`)) fail('intake_issue_identity', 'selected comment does not belong to the target issue');
        if (typeof parsed['updated_at'] !== 'string' || !Number.isFinite(Date.parse(parsed['updated_at'])) ||
            (parsed['body'] !== null && typeof parsed['body'] !== 'string') || (kind === 'issue' && typeof parsed['title'] !== 'string')) fail('intake_malformed_issue', 'issue/comment lacks title, body or revision');
        const text = kind === 'issue' ? `${parsed['title'] as string}\n\n${(parsed['body'] as string | null) ?? ''}` : (parsed['body'] as string | null) ?? '';
        snapshots.push({ id: `s${snapshots.length + 1}`, kind, locator, revision: parsed['updated_at'], sha256: digest(raw), raw, text, frontmatter: null, identifiers: { repo: `${coordinates.owner}/${coordinates.repo}`, number: String(coordinates.number), ...(expectedId === undefined ? {} : { commentId: String(expectedId) }) } });
        if (kind === 'issue' && text.trim() === '') addGap({ code: 'intake_incomplete_issue', locator, question: 'Captured issue title/body has no non-whitespace planning content; supply a goal and acceptance explicitly. Exact response bytes remain retained.' });
      } catch (error) {
        if (raw !== '' && Buffer.byteLength(raw) <= INTAKE_MAX_SOURCE_BYTES) snapshots.push({ id: `s${snapshots.length + 1}`, kind, locator, revision: `sha256:${digest(raw)}`, sha256: digest(raw), raw, text: '', frontmatter: null, identifiers: {} });
        addGap(gap(error, locator));
        if (error instanceof GhRateLimitedError) rateLimited = true;
      }
    };
    await capture(`repos/${coordinates.owner}/${coordinates.repo}/issues/${coordinates.number}`, coordinates.url, 'issue');
    for (const id of source.commentIds ?? []) {
      const locator = `${coordinates.url}#issuecomment-${id}`;
      if (rateLimited) addGap({ code: 'intake_supporting_source_unattempted', locator, question: 'Selected comment was not attempted because GitHub rate-limited this capture batch; its contents are unknown. Retry explicitly with a new request.' });
      else await capture(`repos/${coordinates.owner}/${coordinates.repo}/issues/comments/${id}`, locator, 'comment', id);
    }
  } else {
    const supplied = [source.document, ...(source.supporting ?? [])];
    for (const input of supplied) {
      let locator = input.path ?? input.uploadPath!;
      try {
        const location = documentLocation(repo, input, ports.uploadsDir);
        locator = location.locator;
        if (!['.md', '.txt'].includes(extname(location.path).toLowerCase()) || (source.kind === 'bmad' && extname(location.path).toLowerCase() !== '.md')) fail('intake_document_type', 'specs require .md/.txt; BMAD source data requires .md');
        const raw = documentBytes(location.root, location.path);
        const metadata = frontmatter(raw);
        const snapshot: Snapshot = { id: `s${snapshots.length + 1}`, kind: source.kind, locator, revision: `sha256:${digest(raw)}`, sha256: digest(raw), raw, text: raw, frontmatter: metadata.frontmatter, identifiers: metadata.identifiers };
        snapshots.push(snapshot);
        for (const question of metadata.questions) addGap({ code: 'intake_identifying_metadata', locator, question });
        if (metadata.malformed) addGap({ code: 'intake_malformed_document', locator, question: 'Unterminated frontmatter: clarify this document; captured bytes remain data.' });
        if (raw.trim() === '' || /^\s*(?:---|#)\s*$/u.test(raw)) addGap({ code: 'intake_incomplete_document', locator, question: 'Document does not state a usable requirement; provide a complete goal and acceptance.' });
      } catch (error) { addGap(gap(error, locator)); }
    }
    if (source.kind === 'bmad') {
      const capturedPaths = new Set(snapshots.filter((snapshot) => !snapshot.locator.startsWith('upload:')).map((snapshot) => snapshot.locator));
      for (const snapshot of snapshots) {
        for (const { label, target } of storyReferences(snapshot.raw)) {
          try {
            const candidate = target === null ? null : storyPath(target, snapshot.locator);
            if (candidate === null || !capturedPaths.has(candidate)) addGap({
              code: 'intake_missing_story', locator: target ?? `[${label}]`,
              question: `Referenced story ${target ?? label} has no successfully captured explicit document; its contents are unknown. Provide it explicitly or clarify scope.`,
            });
          } catch (error) { addGap(gap(error, target ?? `[${label}]`)); }
        }
      }
    }
  }
  // Conservative inventory: every nonblank line, including metadata/status,
  // stays traceable. Classification and satisfaction are never inferred.
  const requirements: Capture['requirements'][number][] = [];
  inventory: for (const snapshot of snapshots) {
    for (let start = 0; start <= snapshot.text.length;) {
      const newline = snapshot.text.indexOf('\n', start);
      const end = newline === -1 ? snapshot.text.length : newline;
      const line = snapshot.text.slice(start, end);
      if (line.trim() !== '') {
        requirements.push({ id: `${snapshot.id}-r${start}`, trace: { snapshotId: snapshot.id, start, end, quote: line } });
        if (requirements.length > INTAKE_MAX_REQUIREMENTS) {
          addGap({ code: 'intake_source_bounds', locator: snapshot.locator, question: `Diagnostic requirement inventory is a capped prefix of ${INTAKE_MAX_REQUIREMENTS + 1} nonblank lines, not a complete requirement inventory. Complete exact bytes of every captured source remain in snapshots; narrow sources before planning.` });
          break inventory;
        }
      }
      if (newline === -1) break;
      start = newline + 1;
    }
  }
  return { snapshots, gaps, requirements };
}

export function canonicalManagedRepo(requested: string, registered: readonly string[]): string {
  if (!isAbsolute(requested) || resolve(requested) !== requested) fail('intake_repository', 'repoPath must be an explicit normalized absolute managed repository root');
  try {
    const canonical = realpathSync(requested);
    const selected = registered.includes(requested) || registered.some((path) => {
      try { return realpathSync(path) === requested; } catch { return false; }
    });
    if (!selected || canonical !== requested) fail('intake_repository', 'repoPath must be the canonical root in the explicit managed repository registry');
    return requested;
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return fail('intake_repository', 'managed repository identity is unavailable; restore the explicit registry/root before intake');
  }
}
