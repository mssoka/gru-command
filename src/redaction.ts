/**
 * Credential redaction for text GC publishes or hands on (a PR comment, a
 * review body, a minion directive, a ledger record that may be relayed):
 * spans that look like a credential become one fixed placeholder.
 */

export const REDACTION_PLACEHOLDER = '[REDACTED]';

function redaction(_value: string): string {
  // A fixed placeholder: any digest of the redacted bytes would publish an
  // offline brute-force oracle for low-entropy secrets. The scope-disclosure
  // decoder uses the same literal to distinguish evidence erased by a
  // redaction span from an authentic pre-disclosure absence.
  return REDACTION_PLACEHOLDER;
}

/** Keep verification evidence private when it resembles a credential. The
 * durable local report remains unchanged; only the PR-facing copy is masked. */
export function redactReviewForPublication(body: string): string {
  const patterns = [
    /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gu,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
    /\bAKIA[0-9A-Z]{16}\b/gu,
    /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|secret[_-]?key|api[_-]?secret|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s`'"]+)/giu,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  ];
  return patterns.reduce((text, pattern) => text.replace(pattern, redaction), body);
}
