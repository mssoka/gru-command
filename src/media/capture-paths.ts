/**
 * `[capture] paths` globs (owner ruling 2026-11-15, Q4: code decides when
 * media is owed). A diff that touches a path matching one of these globs owes
 * media at its head, or a skip reason in the shot list.
 *
 * The syntax is the small, ecosystem-neutral subset every glob dialect agrees
 * on, matched against repository-relative paths with `/` separators:
 *
 *   `*`   any run of characters inside one path segment (never `/`)
 *   `**`  any number of whole segments, including none (`web/**` matches
 *         `web/a.ts` and `web/a/b.ts`; a leading `**` segment before `x.css`
 *         matches `x.css` at any depth)
 *   `?`   one character inside a segment
 *   `!`   (leading) an exclusion: a path it matches owes nothing, whatever
 *         else matches it (a `!` entry for the test files keeps a test-only
 *         diff from owing media)
 *
 * Every other character is literal. A pattern names no absolute path, no
 * `..` segment and no brace or class set: an unsupported form fails loud with
 * the reason, so a glob never silently matches less than its author meant.
 */

/** A `[capture] paths` entry that cannot be used. */
export class CaptureGlobError extends Error {
  constructor(readonly pattern: string, reason: string) {
    super(`capture path glob ${JSON.stringify(pattern)} ${reason}`);
    this.name = 'CaptureGlobError';
  }
}

export const CAPTURE_GLOB_MAX_CHARS = 200;

/** A validated glob: its normalized text (with any leading `!`), whether it
 * excludes, and the matcher of its path part. */
export interface CaptureGlob {
  readonly pattern: string;
  readonly exclude: boolean;
  readonly matches: (path: string) => boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/gu, (character) => `\\${character}`);
}

/** Validate and compile one glob. Throws {@link CaptureGlobError}. */
export function compileCaptureGlob(raw: string): CaptureGlob {
  const pattern = raw.trim();
  if (pattern === '' || pattern === '!') throw new CaptureGlobError(raw, 'must not be empty');
  if ([...pattern].length > CAPTURE_GLOB_MAX_CHARS) throw new CaptureGlobError(raw, `must be at most ${CAPTURE_GLOB_MAX_CHARS} characters`);
  if (/\p{Cc}/u.test(pattern)) throw new CaptureGlobError(raw, 'must not contain control characters');
  const exclude = pattern.startsWith('!');
  const body = exclude ? pattern.slice(1) : pattern;
  if (body.startsWith('/') || /^[A-Za-z]:/u.test(body)) throw new CaptureGlobError(raw, 'must be relative to the repository root');
  if (body.includes('\\')) throw new CaptureGlobError(raw, 'must use / as the separator');
  if (body.startsWith('!')) throw new CaptureGlobError(raw, 'may start with one ! only');
  if (/[[\]{}]/u.test(body)) throw new CaptureGlobError(raw, 'must not use [ ] or { } sets (write one glob per alternative)');
  const segments = body.split('/');
  if (segments.some((segment) => segment === '')) throw new CaptureGlobError(raw, 'must not contain an empty segment (// or a trailing /)');
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new CaptureGlobError(raw, 'must not contain . or .. segments');
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    throw new CaptureGlobError(raw, 'may use ** only as a whole segment (web/**/x.css, not web/**.css)');
  }
  let source = '^';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Zero or more whole segments. As the last segment it also needs at
      // least one character after the directory (`web/**` is everything
      // below web/, not web itself, which is a directory, never a file).
      source += last ? '.+' : '(?:[^/]+/)*';
      return;
    }
    source += segment
      .split('')
      .map((character) => (character === '*' ? '[^/]*' : character === '?' ? '[^/]' : escapeRegex(character)))
      .join('');
    if (!last) source += '/';
  });
  source += '$';
  const regex = new RegExp(source, 'u');
  return { pattern, exclude, matches: (path) => regex.test(path) };
}

/** One changed path that owes media, with the first glob it matched. */
export interface TouchedCapturePath {
  readonly path: string;
  readonly glob: string;
}

/** The changed paths that match an including glob and no excluding one, in
 * the order given. */
export function touchedCapturePaths(globs: readonly CaptureGlob[], changed: readonly string[]): readonly TouchedCapturePath[] {
  const touched: TouchedCapturePath[] = [];
  for (const path of changed) {
    if (globs.some((candidate) => candidate.exclude && candidate.matches(path))) continue;
    const glob = globs.find((candidate) => !candidate.exclude && candidate.matches(path));
    if (glob !== undefined) touched.push({ path, glob: glob.pattern });
  }
  return touched;
}
