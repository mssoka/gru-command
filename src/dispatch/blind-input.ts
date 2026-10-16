import { createHash } from 'node:crypto';
import type { JobAmendmentRecord } from '../review-inputs/amendments.js';
import { amendmentSupersessions } from '../review-inputs/amendments.js';

/**
 * Blind-review input isolation (issue #316).
 *
 * A blind reviewer is only independent if the INPUT it can read carries no
 * task specification, prior assessment, deferred-work or triage text. A clean
 * checkout and a reproducible diff do not prove that: history embedded in a
 * document-like file (extensionless or .md/.markdown/.txt/.rst/.adoc), an
 * unfiltered historical diff, or a grep that lands in a planning file all
 * defeat it. Content scanning is gated to those document-like files; every
 * other file type is judged by path alone, so a source line that merely names a
 * planning path is not exposure. Root cause this module closes: the child's briefing was
 * free-form text composed by the parent from its ORIGINAL contract; nothing at
 * commissioning consulted the parent's EFFECTIVE contract (amendments,
 * including administrative clarifications) or inspected the input the child
 * would be handed, and report settlement (`acted`/`Done`) was the only
 * lifecycle fact — so a settled report was indistinguishable from independent
 * coverage.
 *
 * Everything here is deterministic and pure (no I/O): the dispatcher validates
 * BEFORE any worktree or reviewer exists, records provenance, and later checks
 * observed tool results against the SAME rule. Claims-needed reviewers
 * (`review_role: "claims"`) are a separate contract and never pass through it.
 */

export const REVIEW_ROLES = ['blind', 'claims'] as const;
export type ReviewRole = (typeof REVIEW_ROLES)[number];

/** Explicit role wins; otherwise a lane NAMED blind (word-bounded, as the
 * shipped `review (blind)` convention) is blind. Anything else is
 * unclassified (null): historical bindings are never re-interpreted. */
export function reviewRoleFor(input: {
  readonly explicit?: string | undefined;
  readonly title: string;
  readonly displayName?: string | undefined;
}): ReviewRole | null {
  if (input.explicit !== undefined) {
    if (!(REVIEW_ROLES as readonly string[]).includes(input.explicit)) {
      throw new BlindInputRefusal({
        code: 'invalid_review_role',
        status: 400,
        message: `review_role must be one of ${REVIEW_ROLES.join('|')} (got ${JSON.stringify(input.explicit)})`,
        violations: [],
        correction: `Send review_role as "blind" (isolated input) or "claims" (reviewer that legitimately needs claims).`,
      });
    }
    return input.explicit as ReviewRole;
  }
  return /\bblind\b/iu.test(`${input.title}\n${input.displayName ?? ''}`) ? 'blind' : null;
}

export type BlindViolationCode =
  | 'excluded-path'
  | 'history-content'
  | 'digest-mismatch'
  | 'target-mismatch'
  | 'empty-package'
  | 'package-required';

export interface BlindViolation {
  readonly code: BlindViolationCode;
  readonly where: string;
  readonly detail: string;
}

export type BlindRefusalCode =
  | 'invalid_review_role'
  | 'invalid_input_package'
  | 'blind_input_refused'
  | 'stale_parent_contract'
  | 'blind_coverage_owned'
  | 'blind_coverage_unreadable';

/** A named refusal at the commissioning boundary. `correction` is the path a
 * stranger can act on; `violations` never carry the private text itself. */
export class BlindInputRefusal extends Error {
  readonly code: BlindRefusalCode;
  readonly status: 400 | 409 | 422;
  readonly violations: readonly BlindViolation[];
  readonly correction: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(input: {
    readonly code: BlindRefusalCode;
    readonly status: 400 | 409 | 422;
    readonly message: string;
    readonly violations: readonly BlindViolation[];
    readonly correction: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = 'BlindInputRefusal';
    this.code = input.code;
    this.status = input.status;
    this.violations = input.violations;
    this.correction = input.correction;
    this.details = input.details ?? {};
  }
}

// ---------------------------------------------------------------------------
// Isolation rule
// ---------------------------------------------------------------------------

export interface BlindIsolationRule {
  readonly version: 'blind-isolation/v1';
  /** Private job material: never lifted by a permit. */
  readonly privateGlobs: readonly string[];
  /** Parent-declared exclusions (may be lifted for versioned config). */
  readonly excludeGlobs: readonly string[];
  /** Explicit versioned-config paths the parent allows. */
  readonly permitPaths: readonly string[];
  readonly requirePackage: boolean;
  /** Number of parent directives folded in (0 = defaults only). */
  readonly directives: number;
  readonly sha256: string;
}

const PRIVATE_GLOBS: readonly string[] = [
  '_bmad-output/**',
  'investigations/**',
  'docs/issues/**',
  '.gru-command/jobs/**',
  '.gru-command/reports/**',
  '.gru-command/reviews/**',
  '.gru-command/artifacts/**',
  '.gru-command/journal/**',
];

/** Versioned configuration formats a permit may lift. */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set(['.toml', '.json', '.yaml', '.yml']);
/** Documents scanned by content (code files are not: a string literal that
 * names a planning path inside source is not exposure). */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '']);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function finalizeRule(rule: Omit<BlindIsolationRule, 'sha256'>): BlindIsolationRule {
  return { ...rule, sha256: sha256(JSON.stringify(rule)) };
}

export const DEFAULT_BLIND_ISOLATION_RULE: BlindIsolationRule = finalizeRule({
  version: 'blind-isolation/v1',
  privateGlobs: PRIVATE_GLOBS,
  excludeGlobs: [],
  permitPaths: [],
  requirePackage: false,
  directives: 0,
});

const DIRECTIVE_LINE = /^\s*(?:[-*]\s+)?blind-isolation\s*:\s*(.*?)\s*$/imu;

function directivesOf(text: string, ignoredAnchors: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = DIRECTIVE_LINE.exec(line);
    if (match === null) continue;
    if (ignoredAnchors.some((anchor) => line.includes(anchor))) continue;
    out.push(match[1] ?? '');
  }
  return out;
}

/**
 * The parent's EFFECTIVE blind-isolation rule: defaults plus directive lines
 * (`blind-isolation: exclude <glob>` / `permit <path>` / `require-package`)
 * from the original briefing and every amendment that is still effective —
 * administrative clarifications included, superseded ones and superseded
 * original lines ignored. Amendments are append-only, so the rule is a pure
 * function of the contract version the child is commissioned against.
 */
export function deriveBlindIsolationRule(input: {
  readonly briefing: string | null;
  readonly amendments: readonly JobAmendmentRecord[];
}): BlindIsolationRule {
  const ordered = [...input.amendments].sort((left, right) => left.version - right.version);
  const superseded = amendmentSupersessions(ordered);
  const effective = ordered.filter((amendment) => !superseded.has(amendment.id));
  const anchors = effective.flatMap((amendment) =>
    amendment.supersedes.filter((entry) => entry.startsWith('original:')).map((entry) => entry.slice('original:'.length)),
  );
  const lines = [
    ...directivesOf(input.briefing ?? '', anchors),
    ...effective.flatMap((amendment) => directivesOf(amendment.body, [])),
  ];
  const exclude: string[] = [];
  const permit: string[] = [];
  let requirePackage = false;
  for (const directive of lines) {
    const [verb, ...rest] = directive.split(/\s+/u);
    const argument = rest.join(' ');
    if (verb === 'exclude' && argument !== '') exclude.push(argument);
    else if (verb === 'permit' && argument !== '') permit.push(argument);
    else if (verb === 'require-package' && argument === '') requirePackage = true;
    else throw new Error(`unknown blind-isolation directive "${directive}" — use "exclude <glob>", "permit <path>" or "require-package"`);
  }
  return finalizeRule({
    version: 'blind-isolation/v1',
    privateGlobs: PRIVATE_GLOBS,
    excludeGlobs: exclude,
    permitPaths: permit,
    requirePackage,
    directives: lines.length,
  });
}

/** Rebuild a recorded rule; the digest must match its content, so access is
 * never judged against a rule different from the one admitted under. */
export function reviveBlindIsolationRule(parts: {
  readonly excludeGlobs: readonly string[];
  readonly permitPaths: readonly string[];
  readonly requirePackage: boolean;
  readonly directives: number;
  readonly sha256: string;
}): BlindIsolationRule {
  const rule = finalizeRule({
    version: 'blind-isolation/v1',
    privateGlobs: PRIVATE_GLOBS,
    excludeGlobs: parts.excludeGlobs,
    permitPaths: parts.permitPaths,
    requirePackage: parts.requirePackage,
    directives: parts.directives,
  });
  if (rule.sha256 !== parts.sha256) {
    throw new Error(`recorded blind isolation rule digest ${parts.sha256} does not match its content — refusing to judge access against a different rule`);
  }
  return rule;
}

/** Compiled glob patterns: a large tool output classifies many candidate
 * paths against the same few globs. */
const compiledGlobs = new Map<string, RegExp>();
const MAX_COMPILED_GLOBS = 1024;
function globToRegExp(glob: string): RegExp {
  const cached = compiledGlobs.get(glob);
  if (cached !== undefined) {
    // Least recently used goes first: a hit moves to the newest end.
    compiledGlobs.delete(glob);
    compiledGlobs.set(glob, cached);
    return cached;
  }
  const compiled = compileGlob(glob);
  if (compiledGlobs.size >= MAX_COMPILED_GLOBS) compiledGlobs.delete(compiledGlobs.keys().next().value as string);
  compiledGlobs.set(glob, compiled);
  return compiled;
}
function compileGlob(glob: string): RegExp {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else out += '[^/]*';
    } else out += char.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** A path whose SHAPE alone puts it outside the package: empty, absolute
 * (POSIX, a Windows drive or a UNC share), a `..` segment or a NUL — in
 * either slash direction. */
function outsidePackageShape(path: string): boolean {
  const slashed = path.replace(/\\/gu, '/');
  return slashed === '' || slashed.startsWith('/') || /^[A-Za-z]:\//u.test(slashed) || /(^|\/)\.\.(\/|$)/u.test(slashed) || slashed.includes('\0');
}

/** Why a package path is not admissible, or null when it is. */
export function classifyBlindPath(rawPath: string, rule: BlindIsolationRule): string | null {
  const path = rawPath.replace(/\\/gu, '/');
  if (outsidePackageShape(path)) {
    return `invalid package path "${rawPath}" (must be a relative path inside the repository)`;
  }
  const normalized = path.replace(/^\.\//u, '');
  if (rule.privateGlobs.some((glob) => globToRegExp(glob).test(normalized))) {
    return `"${normalized}" is private job material (planning, spec, review or triage artifacts)`;
  }
  const permitted =
    rule.permitPaths.includes(normalized) && CONFIG_EXTENSIONS.has(extensionOf(normalized));
  if (!permitted && rule.excludeGlobs.some((glob) => globToRegExp(glob).test(normalized))) {
    return `"${normalized}" is excluded by the parent isolation rule`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// History-bearing content
// ---------------------------------------------------------------------------

interface ContentFamily {
  readonly name: string;
  readonly weight: number;
  readonly test: (line: string) => boolean;
}

const CONTENT_FAMILIES: readonly ContentFamily[] = [
  {
    name: 'prior-assessment',
    weight: 2,
    test: (line) =>
      /^\s{0,3}(?:#{1,6}\s*|[-*]\s+|\d+\.\s+)?\**(?:(?:prior|previous|earlier|replacement)[ -])+(?:blind[ -])?(?:assessments?|reviews?|findings?|triage)\b/iu.test(line),
  },
  {
    name: 'disposition',
    weight: 2,
    test: (line) => /^\s{0,3}(?:[-*]\s+)?\**(?:disposition|triage)\**\s*[:=]/iu.test(line),
  },
  {
    name: 'round-findings',
    weight: 1,
    test: (line) =>
      /^\s{0,3}(?:#{1,6}\s*|[-*]\s+)?\**R\d+(?:\s*[/,&-]\s*R?\d+)*\**\s*(?:findings?|dispositions?|review)\b/iu.test(line),
  },
  {
    name: 'deferred-work',
    weight: 1,
    test: (line) => /^\s{0,3}#{1,6}\s*.*\b(?:deferred[ -]work|deferred findings|triage)\b/iu.test(line),
  },
  {
    name: 'task-spec-acceptance',
    weight: 1,
    test: (line) => /^\s{0,3}#{1,6}\s*acceptance criteria\b/iu.test(line),
  },
  {
    name: 'task-spec-status',
    weight: 1,
    test: (line) => /^status:\s*(?:ready-for-dev|in-progress|ready|done)\b/iu.test(line),
  },
  {
    name: 'task-spec-story',
    weight: 1,
    test: (line) => /^\s{0,3}#{1,6}\s*(?:user story|story|tasks?(?:\s*\/\s*subtasks)?)\b/iu.test(line),
  },
];

const EXCLUSION_THRESHOLD = 2;
/** `path:12:` grep prefixes and `  12→`/`12:` paged-read gutters. */
const LINE_PREFIX = /^(?:[^\s:][^\s]*?:\d+[:-]|\s*\d+[→|:\t])\s?/u;

export interface ContentClassification {
  readonly excluded: boolean;
  readonly score: number;
  readonly families: readonly string[];
}

/** Classify text by what it says (structure-anchored, so a source line that
 * merely names a planning file never counts). */
export function classifyHistoryContent(text: string): ContentClassification {
  const hits = new Set<string>();
  let score = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(LINE_PREFIX, '');
    if (/^\s*(?:\/\/|\/\*)/u.test(line)) continue;
    for (const family of CONTENT_FAMILIES) {
      if (!hits.has(family.name) && family.test(line)) {
        hits.add(family.name);
        score += family.weight;
      }
    }
  }
  return { excluded: score >= EXCLUSION_THRESHOLD, score, families: [...hits] };
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export interface BlindPackageFile {
  readonly path: string;
  readonly content: string;
  readonly sha256?: string;
  readonly blobSha?: string;
}

export interface BlindInputPackage {
  readonly baseSha: string;
  readonly targetSha: string;
  readonly diff?: { readonly text: string; readonly sha256?: string };
  readonly files?: readonly BlindPackageFile[];
}

export interface BlindPackageProvenance {
  readonly version: 'blind-package/v1';
  readonly baseSha: string;
  readonly targetSha: string;
  readonly diffSha256: string | null;
  readonly diffPaths: readonly string[];
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly blobSha: string }[];
  readonly packageSha256: string;
}

export interface BlindPackageEvaluation {
  readonly ok: boolean;
  readonly violations: readonly BlindViolation[];
  readonly provenance: BlindPackageProvenance | null;
}

/** Git's own object id for a blob, so an archive can be matched to frozen
 * target blobs byte for byte. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

interface DiffSection {
  readonly path: string;
  readonly oldPath: string;
  readonly text: string;
  readonly body: string;
}

function splitDiff(text: string): readonly DiffSection[] {
  const header = /^diff --git a\/(.+?) b\/(.+)$/u;
  const groups: { oldPath: string; path: string; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const match = header.exec(line);
    if (match !== null) groups.push({ oldPath: match[1]!, path: match[2]!, lines: [line] });
    else groups.at(-1)?.lines.push(line);
  }
  return groups.map((group) => ({
    path: group.path,
    oldPath: group.oldPath,
    text: group.lines.join('\n'),
    body: group.lines
      .slice(1)
      .filter((line) => !/^(?:index |--- |\+\+\+ |@@ )/u.test(line))
      .map((line) => line.slice(1))
      .join('\n'),
  }));
}

function sectionViolations(section: DiffSection, rule: BlindIsolationRule): readonly BlindViolation[] {
  const out: BlindViolation[] = [];
  for (const path of new Set([section.path, section.oldPath])) {
    const reason = classifyBlindPath(path, rule);
    if (reason !== null) out.push({ code: 'excluded-path', where: path, detail: reason });
  }
  if (out.length === 0 && DOC_EXTENSIONS.has(extensionOf(section.path)) && classifyHistoryContent(section.body).excluded) {
    out.push({
      code: 'history-content',
      where: section.path,
      detail: `"${section.path}" carries task-spec, prior-assessment, deferred-work or triage text in its diff body`,
    });
  }
  return out;
}

export function evaluateBlindPackage(pkg: BlindInputPackage, rule: BlindIsolationRule): BlindPackageEvaluation {
  const violations: BlindViolation[] = [];
  const files = pkg.files ?? [];
  if (pkg.diff === undefined && files.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'empty-package', where: 'input_package', detail: 'the package carries neither a diff nor any file' }],
      provenance: null,
    };
  }
  const fileRecords: { path: string; sha256: string; blobSha: string }[] = [];
  for (const file of files) {
    const reason = classifyBlindPath(file.path, rule);
    if (reason !== null) {
      violations.push({ code: 'excluded-path', where: file.path, detail: reason });
      continue;
    }
    const computed = sha256(file.content);
    const blob = gitBlobSha(file.content);
    if (file.sha256 !== undefined && file.sha256 !== computed) {
      violations.push({ code: 'digest-mismatch', where: file.path, detail: `declared sha256 does not match the bytes supplied for "${file.path}"` });
    }
    if (file.blobSha !== undefined && file.blobSha !== blob) {
      violations.push({ code: 'digest-mismatch', where: file.path, detail: `declared git blob id does not match the bytes supplied for "${file.path}"` });
    }
    if (DOC_EXTENSIONS.has(extensionOf(file.path)) && classifyHistoryContent(file.content).excluded) {
      violations.push({
        code: 'history-content',
        where: file.path,
        detail: `"${file.path}" carries task-spec, prior-assessment, deferred-work or triage text`,
      });
    }
    fileRecords.push({ path: file.path.replace(/^\.\//u, ''), sha256: computed, blobSha: blob });
  }
  let diffSha: string | null = null;
  const diffPaths: string[] = [];
  if (pkg.diff !== undefined) {
    diffSha = sha256(pkg.diff.text);
    if (pkg.diff.sha256 !== undefined && pkg.diff.sha256 !== diffSha) {
      violations.push({ code: 'digest-mismatch', where: 'diff', detail: 'declared diff sha256 does not match the diff bytes supplied' });
    }
    for (const section of splitDiff(pkg.diff.text)) {
      diffPaths.push(section.path);
      violations.push(...sectionViolations(section, rule));
    }
  }
  if (violations.length > 0) return { ok: false, violations, provenance: null };
  const sorted = [...fileRecords].sort((left, right) => left.path.localeCompare(right.path));
  const identity = {
    version: 'blind-package/v1' as const,
    baseSha: pkg.baseSha,
    targetSha: pkg.targetSha,
    diffSha256: diffSha,
    diffPaths,
    files: sorted,
  };
  return { ok: true, violations: [], provenance: { ...identity, packageSha256: sha256(JSON.stringify(identity)) } };
}

/** The briefing is part of the child's input: history-bearing prose pasted
 * into it is refused like any package file. Naming a path is not exposure. */
export function evaluateBlindBriefing(briefing: string, _rule: BlindIsolationRule): readonly BlindViolation[] {
  return classifyHistoryContent(briefing).excluded
    ? [{ code: 'history-content', where: 'briefing', detail: 'the briefing embeds task-spec, prior-assessment, deferred-work or triage text' }]
    : [];
}

function refusalField(field: string, message: string): BlindInputRefusal {
  return new BlindInputRefusal({
    code: 'invalid_input_package',
    status: 400,
    message: `input_package${field === '' ? '' : `.${field}`}: ${message}`,
    violations: [],
    correction: 'Send input_package as {base_sha, target_sha, diff?: {text, sha256?}, files?: [{path, content, sha256?, blob_sha?}]}.',
  });
}

/** Parse the HTTP shape; every present-but-malformed field fails loud. */
export function parseBlindInputPackage(raw: unknown): BlindInputPackage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw refusalField('', 'must be an object');
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['base_sha', 'target_sha', 'diff', 'files']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw refusalField('', `unknown field "${key}"`);
  const str = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.trim() === '') throw refusalField(name, 'must be a non-empty string');
    return value.trim();
  };
  const baseSha = str(body['base_sha'], 'base_sha');
  const targetSha = str(body['target_sha'], 'target_sha');
  let diff: { text: string; sha256?: string } | undefined;
  if (body['diff'] !== undefined) {
    const d = body['diff'];
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw refusalField('diff', 'must be an object');
    const dd = d as Record<string, unknown>;
    for (const key of Object.keys(dd)) if (key !== 'text' && key !== 'sha256') throw refusalField('diff', `unknown field "${key}"`);
    if (typeof dd['text'] !== 'string') throw refusalField('diff.text', 'must be a string');
    diff = { text: dd['text'], ...(dd['sha256'] !== undefined ? { sha256: str(dd['sha256'], 'diff.sha256') } : {}) };
  }
  let files: BlindPackageFile[] | undefined;
  if (body['files'] !== undefined) {
    if (!Array.isArray(body['files'])) throw refusalField('files', 'must be an array');
    files = (body['files'] as unknown[]).map((entry, index) => {
      const name = `files[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw refusalField(name, 'must be an object');
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (!['path', 'content', 'sha256', 'blob_sha'].includes(key)) throw refusalField(name, `unknown field "${key}"`);
      }
      if (typeof e['path'] !== 'string') throw refusalField(`${name}.path`, 'must be a string');
      if (typeof e['content'] !== 'string') throw refusalField(`${name}.content`, 'must be a string (the exact file bytes as UTF-8 text)');
      return {
        path: e['path'],
        content: e['content'],
        ...(e['sha256'] !== undefined ? { sha256: str(e['sha256'], `${name}.sha256`) } : {}),
        ...(e['blob_sha'] !== undefined ? { blobSha: str(e['blob_sha'], `${name}.blob_sha`) } : {}),
      };
    });
  }
  return { baseSha, targetSha, ...(diff !== undefined ? { diff } : {}), ...(files !== undefined ? { files } : {}) };
}

// ---------------------------------------------------------------------------
// Observed access
// ---------------------------------------------------------------------------

export interface ObservedToolResult {
  readonly index: number;
  readonly toolName: string | null;
  readonly text: string;
}

export interface ProhibitedAccess {
  readonly index: number;
  readonly toolName: string | null;
  readonly code: 'excluded-path-read' | 'history-content-read';
  readonly path: string | null;
  readonly detail: string;
  /** Digest only: the private text never rides the ledger. */
  readonly excerptSha256: string;
}

/** A grep result line: `path:LINE:` (or `path:LINE-` context). The path may
 * contain spaces (#357) — it ends at the numeric line delimiter — and may
 * open with a Windows drive (`C:\`), but never starts with whitespace (an
 * indented stack frame is not a grep result). */
const GREP_LINE = /^((?:\.\/|[A-Za-z]:[\\/])?[^\s:][^:\n]*):\d+[:-]/u;

/** No path is longer than PATH_MAX: a spaced grep line's candidates are the
 * word and component starts within its last this-many characters. The path
 * is a suffix of the capture, so every start of a real one — however deep,
 * however much padding precedes it — is judged, and the work per line stays
 * bounded. */
const MAX_PATH_CHARS = 4096;
/** A spaced candidate whose SHAPE may still classify it: its last path
 * component has no whitespace, and it is a parent path (`../x`), an
 * absolute one naming at least a directory and a file (POSIX or a Windows
 * drive), or a UNC share naming a host, a share and a file — a real spaced
 * path (`/Users/a b/notes.md`, `C:/Users/a b/Makefile`), never prose or a
 * clock time whose words follow the last slash (`/var/log/app.log started
 * at 10`), a lone `/word` (`ratio 3 /4:12:`) or a bare `//host` URL. */
function fileLikeOutside(candidate: string): boolean {
  // Index arithmetic, not a split: a dense line yields thousands of
  // candidates, and none allocates per component.
  const lastSlash = candidate.lastIndexOf('/');
  const last = candidate.slice(lastSlash + 1);
  if (last === '' || /\s/u.test(last)) return false;
  if (candidate.startsWith('../')) return true;
  if (candidate.startsWith('//')) {
    // A UNC share (`//host/share/…/file`) names a host — never spaced, so
    // `//a b/…` prose is not one — a share and a file.
    const hostEnd = candidate.indexOf('/', 2);
    const shareEnd = hostEnd < 0 ? -1 : candidate.indexOf('/', hostEnd + 1);
    return hostEnd > 2 && shareEnd > hostEnd + 1 && !/\s/u.test(candidate.slice(2, hostEnd));
  }
  // A POSIX or drive-letter absolute path names a directory and a file (a
  // file directly under a root, `/x` or `C:/x`, is too like prose to count).
  if (candidate.startsWith('/')) return candidate.indexOf('/', 1) > 1;
  if (/^[A-Za-z]:\//u.test(candidate)) return candidate.indexOf('/', 3) > 3;
  return false;
}

/** The paths a tool-result line may name as a grep hit, each with whether
 * its SHAPE alone (absolute, `..`) may classify it. A space-free capture is
 * the path itself. A spaced capture (#357) is ambiguous — prose or a clock
 * time reaches a `:digits:` too — so it, and every suffix of it that starts a
 * word or a path component (`Matches in docs/issues/a b.md:1:` names
 * `docs/issues/a b.md`; `/Users/a b/repo/docs/issues/x.md:1:` names
 * `docs/issues/x.md`), is judged by the isolation globs; by shape only when
 * it is file-like (see fileLikeOutside). */
export function grepPathCandidates(line: string): readonly { readonly path: string; readonly byShape: boolean }[] {
  const captured = GREP_LINE.exec(line)?.[1];
  if (captured === undefined) return [];
  // One separator: a Windows-style hit is judged as the same path.
  const path = captured.trimEnd().replace(/\\/gu, '/');
  if (!/\s/u.test(path)) return [{ path, byShape: true }];
  const from = Math.max(0, path.length - MAX_PATH_CHARS);
  const starts = from === 0 ? [0] : [];
  // A start is a word after whitespace, or a component after a slash — never
  // the second slash of `//`, which no path component begins with.
  const start = /(?<=\s)\S|(?<=\/)[^\s/]/gu;
  start.lastIndex = from;
  for (let match = start.exec(path); match !== null; match = start.exec(path)) starts.push(match.index);
  return starts.map((at) => {
    const candidate = path.slice(at);
    return { path: candidate, byShape: fileLikeOutside(candidate) };
  });
}
/** Why a grep-hit candidate is excluded, or null. */
function excludedGrepPath(candidate: { readonly path: string; readonly byShape: boolean }, rule: BlindIsolationRule): string | null {
  if (outsidePackageShape(candidate.path) && !candidate.byShape) return null;
  return classifyBlindPath(candidate.path, rule);
}

/**
 * What the reviewer actually SAW: tool results whose grep lines land in an
 * excluded path or whose body is history-bearing text. This is observed
 * access, not inferred intent from a file name or a search command.
 */
export function scanObservedAccess(results: readonly ObservedToolResult[], rule: BlindIsolationRule): readonly ProhibitedAccess[] {
  const out: ProhibitedAccess[] = [];
  for (const result of results) {
    const excluded = result.text
      .split('\n')
      .flatMap((line) => grepPathCandidates(line))
      .map((candidate) => ({ path: candidate.path, detail: excludedGrepPath(candidate, rule) }))
      .find((hit) => hit.detail !== null);
    if (excluded !== undefined) {
      out.push({
        index: result.index,
        toolName: result.toolName,
        code: 'excluded-path-read',
        path: excluded.path,
        detail: excluded.detail ?? 'excluded path',
        excerptSha256: sha256(result.text),
      });
      continue;
    }
    const content = classifyHistoryContent(result.text);
    if (content.excluded) {
      out.push({
        index: result.index,
        toolName: result.toolName,
        code: 'history-content-read',
        path: null,
        detail: `tool output carried history-bearing text (${content.families.join(', ')})`,
        excerptSha256: sha256(result.text),
      });
    }
  }
  return out;
}
