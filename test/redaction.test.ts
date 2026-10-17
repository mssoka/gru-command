import { describe, expect, it } from 'vitest';
import { redactCredentials, redactCredentialWindow, redactReviewForPublication, REDACTION_PLACEHOLDER } from '../src/redaction.js';

/**
 * Credential redaction (src/redaction.ts): what GC publishes or hands on —
 * a review body, a PR comment, and the onboarding proof's ledger record and
 * minion directive (#427) — carries no span shaped like a credential, and a
 * diagnostic that only mentions a keyword survives.
 */

describe('redactCredentials', () => {
  it('masks the credential shapes setup and test output prints: URL userinfo, Authorization headers, npm and Slack tokens, .npmrc auth lines', () => {
    const npmToken = `${['npm', '_'].join('')}${'a1B2c3D4e5'.repeat(3)}a1B2c3`;
    const slackToken = `${['xox', 'b-'].join('')}123456789012-abcdefABCDEF`;
    const cases: readonly (readonly [string, string, string])[] = [
      ['npm ERR! fetch https://deploy:s3cretPass@registry.example.com/pkg failed', 's3cretPass', `https://${REDACTION_PLACEHOLDER}@registry.example.com/pkg`],
      ['fatal: unable to access \'https://x-access-token:abc123def@github.com/acme/app.git/\'', 'abc123def', `https://${REDACTION_PLACEHOLDER}@github.com/acme/app.git/`],
      ['> Authorization: Bearer eyJhbGciOi.payload.sig', 'eyJhbGciOi.payload.sig', `Authorization: Bearer ${REDACTION_PLACEHOLDER}`],
      ['authorization: basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==', `authorization: basic ${REDACTION_PLACEHOLDER}`],
      [`publish with ${npmToken} now`, npmToken, `publish with ${REDACTION_PLACEHOLDER} now`],
      [`slack ${slackToken} posted`, slackToken, `slack ${REDACTION_PLACEHOLDER} posted`],
      ['//registry.npmjs.org/:_authToken=npmTokenValue123', 'npmTokenValue123', '//registry.npmjs.org/:_'],
      ['//npm.pkg.github.com/:_password=cGFzc3dvcmQ=', 'cGFzc3dvcmQ=', '//npm.pkg.github.com/:_'],
    ];
    for (const [text, secret, kept] of cases) {
      const redacted = redactCredentials(text);
      expect(redacted, text).not.toContain(secret);
      expect(redacted, text).toContain(REDACTION_PLACEHOLDER);
      expect(redacted, text).toContain(kept);
    }
  });

  it('the keyword rule redacts only a value of at least six characters with a letter or digit: a diagnostic that names a keyword survives', () => {
    for (const diagnostic of [
      'SyntaxError: Unexpected token: \')\'',
      'SyntaxError: Unexpected token: }',
      'Unexpected token: "<"',
      'expected token=x got y',
      'password: ******',
      'secret = abc12',
    ]) expect(redactCredentials(diagnostic), diagnostic).toBe(diagnostic);
    for (const [text, secret] of [
      ['password=hunter22', 'hunter22'],
      ['token: "a quoted secret"', 'a quoted secret'],
      ['api_key = \'s3cret value\'', 's3cret value'],
      ['secret: abc123', 'abc123'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toBe(REDACTION_PLACEHOLDER);
    }
  });

  it('keeps the Perkins publication name as an alias of the same function', () => {
    expect(redactReviewForPublication).toBe(redactCredentials);
  });
});

describe('redactCredentialWindow', () => {
  it('a window that begins inside a private key is redacted from its start to the END line; one whose END never came is redacted to its end', () => {
    expect(redactCredentialWindow('MIIEsecretbody\nmoresecret\n-----END RSA PRIVATE KEY-----\nafter\n')).toBe(`${REDACTION_PLACEHOLDER}\nafter\n`);
    expect(redactCredentialWindow('before\n-----BEGIN EC PRIVATE KEY-----\nMIIEsecretbody\n')).toBe(`before\n${REDACTION_PLACEHOLDER}`);
    // A whole key, and text either side, are left as redactCredentials leaves them.
    expect(redactCredentialWindow('a\n-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----\nb')).toBe(`a\n${REDACTION_PLACEHOLDER}\nb`);
    expect(redactCredentialWindow('plain output\n')).toBe('plain output\n');
  });
});
