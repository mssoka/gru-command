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

  it('masks a JSON-quoted key and the compound secret keys: AWS secret access keys, a service-account private_key, kubeconfig client key data (#427)', () => {
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const pkcs8 = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n';
    for (const [text, secret] of [
      ['{"user": "ci", "password": "hunter22x"}', 'hunter22x'],
      ["{'token': 'abcdef123456'}", 'abcdef123456'],
      [`AWS_SECRET_ACCESS_KEY=${awsSecret}`, awsSecret],
      [`aws_secret_access_key = ${awsSecret}`, awsSecret],
      [`export SECRET-ACCESS-KEY=${awsSecret}`, awsSecret],
      [`{"type": "service_account", "private_key": "${pkcs8}"}`, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
      ['    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo=', 'LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo='],
      ['"client-secret": "oauth-client-s3cret"', 'oauth-client-s3cret'],
      ['PRIVATE_KEY=abcdef0123456789', 'abcdef0123456789'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toContain(REDACTION_PLACEHOLDER);
    }
    // R3's value rule still holds after a quoted key.
    expect(redactCredentials('{"password": "*****"}')).toBe('{"password": "*****"}');
  });

  it('masks camelCase and joined keys, and a key that ends an identifier whatever starts it; AWS STS JSON keeps its AccessKeyId and loses its secret and session token (#427)', () => {
    const sts = [
      '{',
      '    "Credentials": {',
      '        "AccessKeyId": "ASIAIOSFODNN7EXAMPLE",',
      '        "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",',
      '        "SessionToken": "IQoJb3JpZ2luX2VjEXAMPLEtokenBODY",',
      '        "Expiration": "2026-10-17T12:00:00+00:00"',
      '    }',
      '}',
    ].join('\n');
    const redacted = redactCredentials(sts);
    expect(redacted).not.toContain('wJalrXUtnFEMI');
    expect(redacted).not.toContain('IQoJb3JpZ2lu');
    expect(redacted).toContain('"AccessKeyId": "ASIAIOSFODNN7EXAMPLE"');
    expect(redacted).toContain('"Expiration": "2026-10-17T12:00:00+00:00"');
    for (const [text, secret] of [
      ['SecretAccessKey=wJalrXUtnFEMI', 'wJalrXUtnFEMI'],
      ['AwsSecretAccessKey: wJalrXUtnFEMI', 'wJalrXUtnFEMI'],
      ['secretaccesskey=wJalrXUtnFEMI', 'wJalrXUtnFEMI'],
      ['"secretKey": "abcdef123456"', 'abcdef123456'],
      ['{"dbPassword": "hunter22x"}', 'hunter22x'],
      ['"githubToken": "abcdef123456"', 'abcdef123456'],
      ['+ PGPASSWORD=s3cretpw psql -h db', 's3cretpw'],
      ['clientSecret = "oauth-client-s3cret"', 'oauth-client-s3cret'],
      ['SessionToken=IQoJb3JpZ2lu', 'IQoJb3JpZ2lu'],
      ['npmAuthToken: abcdef123456', 'abcdef123456'],
      ['DB_PASSWORD=hunter22x', 'hunter22x'],
      ['vaultsecret=abcdef123456', 'abcdef123456'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toContain(REDACTION_PLACEHOLDER);
    }
    // A key that only starts with one, or names no secret, is left whole; so is R3's short value.
    for (const kept of ['AccessKeyId=ASIAIOSFODNN7EXAMPLE', 'max_tokens=409600', 'tokenizer=wordpiece', 'passwordless=enabled', 'dbPassword: *****', 'hasToken: false']) {
      expect(redactCredentials(kept), kept).toBe(kept);
    }
  });

  it('masks a key that ends its identifier in secretkey, apikey, privatekey, passwd, pwd, password, token or secret (so accesstoken and authtoken too), in any case and with or without _ or -; AccessKeyId and keys that only start with one stay (#427)', () => {
    for (const [text, secret] of [
      ['stripeSecretKey: "sk_live_51Habcdef"', 'sk_live_51Habcdef'],
      ['STRIPE_SECRET_KEY=sk_live_51Habcdef', 'sk_live_51Habcdef'],
      ['googleMapsApiKey=AIzaSyA1b2C3d4', 'AIzaSyA1b2C3d4'],
      ['maps-api-key: AIzaSyA1b2C3d4', 'AIzaSyA1b2C3d4'],
      ['signingPrivateKey=MIIEabcdef123', 'MIIEabcdef123'],
      ['"SIGNING_PRIVATE_KEY": "MIIEabcdef123"', 'MIIEabcdef123'],
      ['slackAccessToken=abcdef123456', 'abcdef123456'],
      ['registry-auth-token: abcdef123456', 'abcdef123456'],
      ['+ MYSQL_PWD=hunter22x mysql -h db', 'hunter22x'],
      ['db_passwd: hunter22x', 'hunter22x'],
      ['{"dbPasswd": "hunter22x"}', 'hunter22x'],
      ['rootPassword=hunter22x', 'hunter22x'],
      ['githubToken: abcdef123456', 'abcdef123456'],
      ['webhookSecret=abcdef123456', 'abcdef123456'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toContain(REDACTION_PLACEHOLDER);
    }
    for (const kept of ['AccessKeyId=ASIAIOSFODNN7EXAMPLE', 'apiKeyId=abcdef123456', 'publicKey=abcdef123456', 'pwdHash: sha256', 'secretKeys: rotated']) {
      expect(redactCredentials(kept), kept).toBe(kept);
    }
  });

  it('leaves the shell\'s own PWD and OLDPWD, a ...PWD assigned a path, and a key a / precedes (a path\'s segment) whole; MYSQL_PWD and the token keys stay masked (#427)', () => {
    for (const kept of ['PWD=/home/runner/app', 'OLDPWD=/tmp', '+ export PWD=/srv/app/build', 'pwd: /home/runner', 'BUILD_PWD=~/work', 'cat: /etc/passwd: Permission denied']) {
      expect(redactCredentials(kept), kept).toBe(kept);
    }
    for (const [text, secret] of [
      ['MYSQL_PWD=s3cretpw', 's3cretpw'],
      ['{"MYSQL_PWD": "hunter22x"}', 'hunter22x'],
      ['ACCESS_TOKEN=abcdef123456', 'abcdef123456'],
      ['access_token: "abcdef123456"', 'abcdef123456'],
      ['x-auth-token: abcdef123456', 'abcdef123456'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toContain(REDACTION_PLACEHOLDER);
    }
  });

  it('masks an armored PGP secret key, whole and in a window that cuts its BEGIN or END line off (#427)', () => {
    const block = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGXpgpSecretBODY\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(redactCredentials(`before\n${block}\nafter`)).toBe(`before\n${REDACTION_PLACEHOLDER}\nafter`);
    expect(redactCredentialWindow('lQOYBGXpgpSecretBODY\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----\nafter\n')).toBe(`${REDACTION_PLACEHOLDER}\nafter\n`);
    expect(redactCredentialWindow('before\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGXpgpSecretBODY\n')).toBe(`before\n${REDACTION_PLACEHOLDER}`);
    // A public key block is not a secret.
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQINBGXpublic\n-----END PGP PUBLIC KEY BLOCK-----';
    expect(redactCredentials(publicKey)).toBe(publicKey);
  });

  it('masks every PRIVATE KEY header: PKCS#8\'s bare one, ENCRYPTED, OPENSSH and the algorithm-named ones (#427)', () => {
    for (const words of ['', 'ENCRYPTED ', 'OPENSSH ', 'RSA ', 'EC ', 'DSA ']) {
      const key = `-----BEGIN ${words}PRIVATE KEY-----\nMIIEsecretKEYbody\n-----END ${words}PRIVATE KEY-----`;
      expect(redactCredentials(`before\n${key}\nafter`), words).toBe(`before\n${REDACTION_PLACEHOLDER}\nafter`);
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
    // PKCS#8's bare header and footer straddle a window the same way (#427).
    expect(redactCredentialWindow('MIIEsecretbody\n-----END PRIVATE KEY-----\nafter\n')).toBe(`${REDACTION_PLACEHOLDER}\nafter\n`);
    expect(redactCredentialWindow('before\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody\n')).toBe(`before\n${REDACTION_PLACEHOLDER}`);
    expect(redactCredentialWindow('before\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEsecretbody\n')).toBe(`before\n${REDACTION_PLACEHOLDER}`);
  });
});
