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

/** The keys whose assigned value is a credential, longest first (`_` or
 * `-` between words, any case): AWS's secret access key, a private key in
 * JSON (a service-account file), kubeconfig's client key data. */
const KEYWORD_KEYS = [
  'aws[_-]secret[_-]access[_-]key', 'secret[_-]access[_-]key', 'private[_-]key', 'client[_-]key[_-]data',
  'api[_-]?key', 'access[_-]?token', 'auth[_-]?token', 'client[_-]?secret', 'refresh[_-]?token', 'secret[_-]?key', 'api[_-]?secret',
  'password', 'secret', 'token',
].join('|');

/** A PEM private key header or footer word run: `PRIVATE KEY` alone
 * (PKCS#8), or after algorithm and format words (`RSA`, `EC`, `OPENSSH`,
 * `ENCRYPTED`). */
const PEM_WORDS = '(?:[A-Z0-9]+ )*PRIVATE KEY';

const PATTERNS: readonly (readonly [RegExp, (match: string, ...groups: string[]) => string])[] = [
  [new RegExp(`-----BEGIN ${PEM_WORDS}-----[\\s\\S]*?-----END ${PEM_WORDS}-----`, 'gu'), redaction],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, redaction],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, redaction],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/gu, redaction],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu, redaction],
  [/\bAKIA[0-9A-Z]{16}\b/gu, redaction],
  [/\bnpm_[A-Za-z0-9]{36}\b/gu, redaction],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, redaction],
  // URL userinfo (`https://user:secret@host`, as npm, pip and git print it).
  [/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/gu, keepPrefix],
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s'"`]+/giu, keepPrefix],
  // An `.npmrc` registry credential: `//registry.example/:_authToken=…`.
  [/(\/\/\S*:_(?:authToken|auth|password)\s*=\s*)\S+/gu, keepPrefix],
  // A key, then an optional closing quote (JSON's `"password": "…"`), then `:` or `=`.
  [new RegExp(`(?<![A-Za-z0-9])(?:${KEYWORD_KEYS})["']?\\s*[:=]\\s*${KEYWORD_VALUE}`, 'giu'), redaction],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, redaction],
];

/** Mask every span of the text that is shaped like a credential. */
export function redactCredentials(body: string): string {
  return PATTERNS.reduce((text, [pattern, replace]) => text.replace(pattern, replace), body);
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
