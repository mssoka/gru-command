/**
 * Credential redaction for text GC publishes or hands on: a PR review body,
 * a PR comment, and, for the onboarding proof (#427), the ledger record of
 * a command's output and failures and the minion directive that carries
 * them. Spans that look like a credential become one fixed placeholder;
 * the caller keeps no unredacted copy of what it records or sends. The
 * bounded tail of a redacted text is cut here too (the onboarding proof's
 * output tail, a failed lane restore's error), so a cut never shows half a
 * credential and never leaves nothing.
 */

export const REDACTION_PLACEHOLDER = '[REDACTED]';

function redaction(_value: string): string {
  // A fixed placeholder: any digest of the redacted bytes would publish an
  // offline brute-force oracle for low-entropy secrets. The scope-disclosure
  // decoder uses the same literal to distinguish evidence erased by a
  // redaction span from an authentic pre-disclosure absence.
  return REDACTION_PLACEHOLDER;
}

/** Keep the text before the credential (a scheme, a header or key name). */
const keepPrefix = (_match: string, prefix: string): string => `${prefix}${REDACTION_PLACEHOLDER}`;

/** A keyword assignment's value: at least 6 characters with a letter or a
 * digit, so a diagnostic such as `Unexpected token: ')'` is left whole. */
const KEYWORD_VALUE = '(?:"(?=[^"]*[A-Za-z0-9])[^"]{6,}"|\'(?=[^\']*[A-Za-z0-9])[^\']{6,}\'|(?=[^\\s`\'"]*[A-Za-z0-9])[^\\s`\'"]{6,})';

/** The value a command line gives a credential flag or auth scheme (#534):
 * the keyword rule's value, and one that does not start with `-`, so the
 * next flag (`--token --verbose`) is no value. */
const ARGV_VALUE = `(?!-)${KEYWORD_VALUE}`;

/** The password of `-u user:password`: at least 6 characters with a letter
 * (a uid:gid pair such as `165536:165536` is no credential), bare or a
 * quoted shell word (`-u deploy:'…'`), whose quotes are part of the value
 * a `ps` line shows. A bare one may start with `-`: only the user is a
 * flag's neighbour. The user may be empty (`-u :password`); the value after
 * the colon is masked however it looks, so a `scheme://` tail is masked
 * too — the mask is also the recorded-command identity the acknowledged
 * kill compares, and masking no credential there would be worse than
 * collapsing two non-credential `-u` arguments. */
const PASSWORD_VALUE = '(?:"(?=[^"]*[A-Za-z])[^"]{6,}"|\'(?=[^\']*[A-Za-z])[^\']{6,}\'|(?=[^\\s`\'"]*[A-Za-z])[^\\s`\'"]{6,})';

/** The keys whose assigned value is a credential, longest first (`_`, `-`
 * or nothing between words, any case, so camelCase too): AWS's secret
 * access key, a private key in JSON (a service-account file), kubeconfig's
 * client key data. Each starts its identifier. (`access_token` and
 * `auth_token` need no entry: `token` matches after the `_`.) */
const KEYWORD_KEYS = [
  'aws[_-]?secret[_-]?access[_-]?key', 'secret[_-]?access[_-]?key', 'private[_-]?key', 'client[_-]?key[_-]?data',
  'api[_-]?key', 'client[_-]?secret', 'refresh[_-]?token', 'secret[_-]?key', 'api[_-]?secret',
  'password', 'secret', 'token',
].join('|');

/** The keys that are a credential's however the identifier begins, as long
 * as they end it (`PGPASSWORD`, `dbPassword`, `githubToken`, AWS STS's
 * `SessionToken` and `SecretAccessKey`, `stripeSecretKey`,
 * `googleMapsApiKey`, `signingPrivateKey`, `db_passwd`). A key that only
 * starts with one of them (`tokens`, `AccessKeyId`) is not one. */
const KEYWORD_ENDINGS = [
  'secret[_-]?access[_-]?key', 'secret[_-]?key', 'api[_-]?key', 'private[_-]?key',
  'password', 'passwd', 'token', 'secret',
].join('|');

/** A key that ends its identifier in `pwd` (`MYSQL_PWD`, an ODBC string's
 * `Pwd=`), except one assigned a path (`/…`, `~…` or a drive's `C:\…`), as
 * the shell's own `PWD` and `OLDPWD` are: a working directory is no
 * secret. */
const PWD_KEY = '[A-Za-z0-9]*?pwd(?!["\']?\\s*[:=]\\s*["\']?(?:[/~]|[A-Za-z]:[\\\\/]))';

/** A PEM private key header or footer word run: `PRIVATE KEY` alone
 * (PKCS#8), or after algorithm and format words (`RSA`, `EC`, `OPENSSH`,
 * `ENCRYPTED`); and an armored PGP secret key's `PGP PRIVATE KEY BLOCK`. */
const PEM_WORDS = '(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?';

/** One pass of redaction over a text. */
type Redaction = (text: string) => string;

const replacing = (pattern: RegExp, replace: (match: string, ...groups: string[]) => string): Redaction =>
  (text) => text.replace(pattern, replace);

const NPMRC_KEY = /:_(?:authToken|auth|password)\s*=\s*/gu;
const SPACE = /\s/u;

/** An `.npmrc` registry credential (`//registry.example/:_authToken=…`, as
 * npm prints it): the value of a `:_authToken`, `:_auth` or `:_password`
 * key whose run of non-space characters holds a `//` before it. One pass
 * that remembers where the last `//` and the last whitespace were, so no
 * run is scanned again for each `//` in it: linear in the text. */
function redactNpmrcAuth(text: string): string {
  let out = '';
  let copied = 0;
  let seen = 0;
  let slashes = -1;
  let space = -1;
  for (const match of text.matchAll(NPMRC_KEY)) {
    if (match.index < copied) continue; // inside a value already masked
    for (; seen < match.index; seen += 1) {
      if (SPACE.test(text[seen]!)) space = seen;
      else if (text[seen] === '/' && text[seen - 1] === '/') slashes = seen;
    }
    // No `//` since the last whitespace: not an `.npmrc` line, and its value
    // is not scanned (a long run of keys with no `//` would otherwise be
    // rescanned at every match: quadratic).
    if (slashes <= space) continue;
    const valueAt = match.index + match[0].length;
    let valueEnd = valueAt;
    while (valueEnd < text.length && !SPACE.test(text[valueEnd]!)) valueEnd += 1;
    if (valueEnd === valueAt) continue;
    out += `${text.slice(copied, valueAt)}${REDACTION_PLACEHOLDER}`;
    copied = valueEnd;
  }
  return `${out}${text.slice(copied)}`;
}

const REDACTIONS: readonly Redaction[] = [
  replacing(new RegExp(`-----BEGIN ${PEM_WORDS}-----[\\s\\S]*?-----END ${PEM_WORDS}-----`, 'gu'), redaction),
  replacing(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, redaction),
  replacing(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, redaction),
  replacing(/\bglpat-[A-Za-z0-9_-]{20,}\b/gu, redaction),
  replacing(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu, redaction),
  replacing(/\bAKIA[0-9A-Z]{16}\b/gu, redaction),
  replacing(/\bnpm_[A-Za-z0-9]{36}\b/gu, redaction),
  replacing(/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, redaction),
  // URL userinfo (`https://user:secret@host`, as npm, pip and git print it).
  // Matched from its `://` (after a scheme's last character), so no start
  // rescans a long run of scheme characters: linear in the text.
  replacing(/(?<=[A-Za-z0-9+.-])(:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/gu, keepPrefix),
  replacing(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s'"`]+/giu, keepPrefix),
  // The forms a process's command line carries (#534). `Authorization: token
  // <value>` (GitHub's scheme), `--token <value>` with a space (the `=` form
  // is the keyword rule's), and curl's `-u <user>:<password>`, whose `-u` is
  // not the tail of a longer flag. A flag with no such value masks nothing.
  // A whole quoted value (`-u "deploy:secret with space"`) runs to its own
  // closing quote, so the password's spaces are inside the mask.
  replacing(new RegExp(`(\\bAuthorization\\s*:\\s*token\\s+)${ARGV_VALUE}`, 'giu'), keepPrefix),
  replacing(new RegExp(`(?<![A-Za-z0-9-])(--token\\s+)${ARGV_VALUE}`, 'gu'), keepPrefix),
  // A whole-quoted value runs to its own closing quote, so a password that
  // holds the other quote character (`-u "deploy:it's-secret"`) still masks
  // whole; the two delimiter-specific passes keep the quotes as `ps` shows
  // them. The user may be empty (`-u ":secret"`).
  replacing(/(?<![A-Za-z0-9-])(-u\s+"[^":]{0,64}:)(?=[^"]*[A-Za-z])[^"]{6,}"/gu,
    (match: string, prefix: string): string => `${prefix}${REDACTION_PLACEHOLDER}${match.slice(-1)}`),
  replacing(/(?<![A-Za-z0-9-])(-u\s+'[^':]{0,64}:)(?=[^']*[A-Za-z])[^']{6,}'/gu,
    (match: string, prefix: string): string => `${prefix}${REDACTION_PLACEHOLDER}${match.slice(-1)}`),
  // A bare user (an empty one too: `-u :secret`) with a bare or quoted
  // password. The lookbehind keeps `cli -u:value` and `--tokenize` alone.
  replacing(new RegExp(`(?<![A-Za-z0-9-])(-u\\s+["']?[^\\s:'"\`-]?[^\\s:'"\`]*["']?:)${PASSWORD_VALUE}`, 'gu'), keepPrefix),
  redactNpmrcAuth,
  // A key, then an optional closing quote (JSON's `"password": "…"`), then
  // `:` or `=`. One whose identifier starts right after a `/` is part of a
  // path (`/etc/passwd:`, `/run/secrets/db_password:`, `/etc/master.passwd:`);
  // that look back is bounded, so a long run of identifier characters
  // stays linear (a longer segment's key is redacted).
  replacing(new RegExp(`(?<![A-Za-z0-9/])(?<!\\/[A-Za-z0-9._-]{1,64})(?:${KEYWORD_KEYS}|[A-Za-z0-9]*?(?:${KEYWORD_ENDINGS})|${PWD_KEY})["']?\\s*[:=]\\s*${KEYWORD_VALUE}`, 'giu'), redaction),
  // A JWT, starting a run of its characters (`eyJ…`): a start inside one
  // (`-eyJ`) would rescan the run for each, so it is not taken.
  replacing(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, redaction),
];

/** Mask every span of the text that is shaped like a credential. */
export function redactCredentials(body: string): string {
  return REDACTIONS.reduce((text, redact) => redact(text), body);
}

/** The Perkins publication's name for {@link redactCredentials} (#427 PR 1b
 * moved it here and widened its use; existing imports keep this name). */
export const redactReviewForPublication = redactCredentials;

const PEM_BEGIN = new RegExp(`-----BEGIN ${PEM_WORDS}-----`, 'u');
const PEM_END = new RegExp(`-----END ${PEM_WORDS}-----`, 'u');

/**
 * {@link redactCredentials} for a window cut from a longer stream (the
 * latest output of a command): a private key whose BEGIN line fell before
 * the window's start is redacted from that start to its END line, and one
 * whose END line never came is redacted to the window's end.
 */
export function redactCredentialWindow(window: string): string {
  let text = window;
  const end = PEM_END.exec(text);
  const begin = PEM_BEGIN.exec(text);
  if (end !== null && (begin === null || begin.index > end.index)) {
    text = `${REDACTION_PLACEHOLDER}${text.slice(end.index + end[0].length)}`;
  }
  text = redactCredentials(text);
  const open = PEM_BEGIN.exec(text);
  return open === null ? text : `${text.slice(0, open.index)}${REDACTION_PLACEHOLDER}`;
}

/** The last `max` UTF-8 bytes of a text, cut at a character boundary. */
export function utf8Tail(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let start = bytes.length - max;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** The first line of a tail that starts inside a line longer than the
 * tail: its words are kept rather than nothing, and it says so. */
const MID_LINE = '(output tail starts mid-line)\n';

/** What stands for a last line with no word boundary to start at: none of
 * it is shown, since its first bytes could be the back half of a token. */
const longLine = (bytes: number): string => `(last line longer than ${String(Math.max(1, Math.floor(bytes / 1024)))} KiB, not shown)\n`;

/** What stands for kept output whose first line the stream's earlier,
 * dropped output began: none of it is shown, and no size is claimed. */
const CUT_MID_LINE = '(output before this was cut mid-line; not shown)\n';

/** The mid-line fallback, for kept bytes whose cut has no line boundary
 * after it: everything up to and including their first whitespace is
 * dropped (a token the cut split never shows its back half); with no
 * whitespace followed by anything, nothing is. */
function fromWord(kept: string): string | null {
  const word = kept.search(/\s/u);
  const rest = word === -1 ? '' : kept.slice(word + 1);
  return rest.trim() === '' ? null : rest;
}

/** The last `max` UTF-8 bytes of a redacted text, starting at a whole
 * line. When its last line alone is longer than that, that line's last
 * bytes from their first word, after {@link MID_LINE}; with no word
 * boundary, {@link longLine}: a command that printed something never
 * records an empty tail. Only ever cut after redaction, so the cut never
 * parts a key from its value. */
export function boundedTail(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const tail = utf8Tail(text, max);
  const line = tail.indexOf('\n');
  const whole = line === -1 ? '' : tail.slice(line + 1);
  if (whole.trim() !== '' || text.trim() === '') return whole;
  const rest = fromWord(utf8Tail(text, max - Buffer.byteLength(MID_LINE, 'utf8')));
  return rest === null ? longLine(max) : `${MID_LINE}${rest}`;
}

/** Bytes of output kept for the record and the minion, after redaction (#427). */
const OUTPUT_TAIL_BYTES = 4 * 1024;
/** Bytes of one stream's output the tail is cut from, after redaction. */
const OUTPUT_WINDOW_BYTES = 16 * 1024;

/** One stream's latest output, as a command keeps it (a setup command's
 * is worktrees/manifest.ts's `SetupStreamTail`). */
export interface OutputWindow {
  readonly text: string;
  /** Earlier output was dropped: the text starts mid-stream. */
  readonly truncated: boolean;
  /** The text starts at a whole line: nothing was dropped, or what was
   * dropped ended at a line break. */
  readonly startsAtLine: boolean;
}

/**
 * The recorded output tail (#427: the onboarding proof's, and a failed lane
 * restore's). Each stream's kept output is redacted whole first (a key
 * whose BEGIN line fell before it is redacted from its start), and only
 * then cut, so no cut GC makes parts a key from its value:
 * - output GC kept whole (none dropped, however long) keeps its last
 *   {@link OUTPUT_WINDOW_BYTES} ({@link boundedTail});
 * - output whose start was dropped before GC saw it keeps what follows
 *   the drop when the dropped part ended at a line break; when it did not,
 *   the first line is dropped after redaction (the earlier cut may have
 *   split a key's name, which no pattern then recognises), and with no
 *   line break at all only {@link CUT_MID_LINE} is recorded: a fragment
 *   the earlier cut made is never shown, not even from a word.
 * The streams together are then cut to the last `max` bytes (default
 * {@link OUTPUT_TAIL_BYTES}) the same way.
 */
export function recordedTail(windows: readonly OutputWindow[], max = OUTPUT_TAIL_BYTES): string {
  const kept = windows.map((window) => {
    const whole = redactCredentialWindow(window.text);
    if (!window.truncated || window.startsAtLine) return boundedTail(whole, OUTPUT_WINDOW_BYTES);
    const line = whole.indexOf('\n');
    const rest = line === -1 ? '' : whole.slice(line + 1);
    return rest.trim() === '' ? CUT_MID_LINE : boundedTail(rest, OUTPUT_WINDOW_BYTES);
  }).filter((text) => text !== '');
  return boundedTail(kept.join('\n'), max);
}
