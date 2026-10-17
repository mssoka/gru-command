/**
 * Credential redaction for text GC publishes or hands on: a PR review body,
 * a PR comment, and, for the onboarding proof (#427), the ledger record of
 * a command's output and failures and the minion directive that carries
 * them. Spans that look like a credential become one fixed placeholder;
 * the caller keeps no unredacted copy of what it records or sends.
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
