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
    for (const kept of ['PWD=/opt/ci/work/app', 'OLDPWD=/tmp', '+ export PWD=/srv/app/build', 'pwd: /opt/ci/work', 'BUILD_PWD=~/work', 'cat: /etc/passwd: Permission denied']) {
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

  it('exempts a PWD key only when its value is a path: an ODBC Pwd= and a JSON "pwd" password are masked, PWD=/… and OLDPWD=~/… stay, and MYSQL_PWD stays masked (#427)', () => {
    for (const [text, secret] of [
      ['Driver={ODBC Driver 18};Server=db;Uid=sa;Pwd=Hunter22x;', 'Hunter22x'],
      ['{"user": "sa", "pwd": "hunter22x"}', 'hunter22x'],
      ['pwd: hunter22x', 'hunter22x'],
      ['MYSQL_PWD=s3cretpw', 's3cretpw'],
    ] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
      expect(redactCredentials(text), text).toContain(REDACTION_PLACEHOLDER);
    }
    for (const kept of ['PWD=/srv/app/build', 'OLDPWD=~/work', 'PWD=C:\\build\\app']) {
      expect(redactCredentials(kept), kept).toBe(kept);
    }
  });

  it('a key whose identifier starts right after a / is part of a path, not a key: permission errors on secret files survive, and the same key assigned is masked (#427)', () => {
    for (const kept of ['cat: /run/secrets/db_password: Permission denied', '/etc/master.passwd: Permission denied', 'open /var/run/app/api-token: no such file or directory']) {
      expect(redactCredentials(kept), kept).toBe(kept);
    }
    for (const [text, secret] of [['DB_PASSWORD=hunter22x', 'hunter22x'], ['spring.datasource.password=hunter22x', 'hunter22x']] as const) {
      expect(redactCredentials(text), text).not.toContain(secret);
    }
  });

  it('is linear on a long run of hyphen- or dot-joined tokens: a 1 MiB line of de-ad-be-ef-… is redacted in well under 5 s (#427)', () => {
    for (const separator of ['-', '.']) {
      const line = `${['de', 'ad', 'be', 'ef'].join(separator)}${separator}`.repeat(1024 * 1024 / 12);
      const started = Date.now();
      expect(redactCredentialWindow(line)).toBe(line);
      expect(Date.now() - started, separator).toBeLessThan(5_000);
    }
  });

  it('is linear on runs of slashes and of JWT-like starts: 1 MiB of ////, of x://, of :_auth= and of eyJ-eyJ-… is redacted in well under 5 s, and the .npmrc and JWT shapes are still masked (#427)', () => {
    const MiB = 1024 * 1024;
    // `:_auth=` with no `//` anywhere: each key used to rescan the rest of the run.
    for (const unit of ['//', 'x://', '//x:_auth=', ':_auth=', 'eyJ-', 'eyJ_']) {
      const line = unit.repeat(Math.floor(MiB / unit.length));
      const started = Date.now();
      redactCredentialWindow(line);
      expect(Date.now() - started, unit).toBeLessThan(5_000);
    }
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZw';
    expect(redactCredentials(`session ${jwt} done`)).toBe(`session ${REDACTION_PLACEHOLDER} done`);
    expect(redactCredentials(`id=${jwt}`)).toBe(`id=${REDACTION_PLACEHOLDER}`);
    const npmrc = redactCredentials('//npm.example:8443/repo/:_authToken = s3cretTokenValue next');
    expect(npmrc).not.toContain('s3cretTokenValue');
    expect(npmrc).toMatch(/^\/\/npm\.example:8443\/repo\/:_.*\[REDACTED\] next$/u);
    expect(redactCredentials('a //r.example/:_auth=one b //r.example/:_auth=two')).toBe(`a //r.example/:_auth=${REDACTION_PLACEHOLDER} b //r.example/:_auth=${REDACTION_PLACEHOLDER}`);
    // With no `//` in the key's run it is no registry credential.
    for (const kept of ['x:_authToken=abc', '// x:_authToken=abc']) expect(redactCredentials(kept), kept).toBe(kept);
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

/**
 * Process command lines (#534): a worktree process's argv reaches the ledger,
 * an event and a response through `redactCredentials`. These top-level cases
 * keep their Vitest `fullName`s exactly the names the heist's red scope passes.
 */
const ARGV_SECRET = 'Zx9Kq3Lm7Pw2Vb5Nc8Td';

it('redacts argv credentials: new token, user and auth-scheme forms', () => {
  const cases: readonly (readonly [string, string])[] = [
    [`curl --token ${ARGV_SECRET} https://host/x`, `curl --token ${REDACTION_PLACEHOLDER} https://host/x`],
    [`node cli.js --token ${ARGV_SECRET}`, `node cli.js --token ${REDACTION_PLACEHOLDER}`],
    [`curl -u deploy:${ARGV_SECRET} https://host/x`, `curl -u deploy:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u deploy:${ARGV_SECRET}`, `curl -u deploy:${REDACTION_PLACEHOLDER}`],
    // A user that looks like an address is still a user; a `//` tail after
    // the colon (a scheme URL) is masked like any other value, so no
    // credential spelling is left whole.
    [`curl -u user@example.com:${ARGV_SECRET} https://host/x`, `curl -u user@example.com:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u deploy://${ARGV_SECRET} https://host/x`, `curl -u deploy:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u "deploy://${ARGV_SECRET}" https://host/x`, `curl -u "deploy:${REDACTION_PLACEHOLDER}" https://host/x`],
    // curl accepts an empty user; the part after the colon is the credential.
    [`curl -u :${ARGV_SECRET} https://host/x`, `curl -u :${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u ":${ARGV_SECRET}" https://host/x`, `curl -u ":${REDACTION_PLACEHOLDER}" https://host/x`],
    // A whole-quoted value may hold the other quote character in its password,
    // and a quoted password may start with a digit or symbol.
    [`curl -u "deploy:it's-${ARGV_SECRET}" https://host/x`, `curl -u "deploy:${REDACTION_PLACEHOLDER}" https://host/x`],
    [`curl -u 'deploy:say"hi-${ARGV_SECRET}' https://host/x`, `curl -u 'deploy:${REDACTION_PLACEHOLDER}' https://host/x`],
    [`curl -u deploy:"it's-${ARGV_SECRET}" https://host/x`, `curl -u deploy:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u 'deploy:1234 5678${ARGV_SECRET}' https://host/x`, `curl -u 'deploy:${REDACTION_PLACEHOLDER}' https://host/x`],
    [`curl -u 'deploy:$ecret pass phrase' https://host/x`, `curl -u 'deploy:${REDACTION_PLACEHOLDER}' https://host/x`],
    [`curl -u 'a b:1234 ${ARGV_SECRET}' https://host/x`, `curl -u 'a b:${REDACTION_PLACEHOLDER}' https://host/x`],
    // A named user:group is indistinguishable from user:password, so it masks;
    // only the all-digit uid:gid pair is left alone (A4).
    ['docker run -u postgres:postgres image', `docker run -u postgres:${REDACTION_PLACEHOLDER} image`],
    [`curl -H Authorization: token ${ARGV_SECRET} https://host/x`, `curl -H Authorization: token ${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -H authorization:Token ${ARGV_SECRET}`, `curl -H authorization:Token ${REDACTION_PLACEHOLDER}`],
    // Inside a shell string, the quote ends the value.
    [`/bin/sh -c curl -H 'Authorization: token ${ARGV_SECRET}' https://host/x`, `/bin/sh -c curl -H 'Authorization: token ${REDACTION_PLACEHOLDER}' https://host/x`],
    [`/bin/sh -c curl -u 'deploy:${ARGV_SECRET}' https://host/x`, `/bin/sh -c curl -u 'deploy:${REDACTION_PLACEHOLDER}' https://host/x`],
    [`/bin/sh -c cli --token "${ARGV_SECRET}" --verbose`, `/bin/sh -c cli --token ${REDACTION_PLACEHOLDER} --verbose`],
    // A password that starts with a dash is still a password after `user:`.
    [`curl -u deploy:-${ARGV_SECRET}`, `curl -u deploy:${REDACTION_PLACEHOLDER}`],
    // A quoted password (its quotes are part of the `ps` line), a quoted
    // user, and a whole quoted value whose password holds a space.
    [`curl -u deploy:'${ARGV_SECRET}' https://host/x`, `curl -u deploy:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u deploy:"${ARGV_SECRET}" https://host/x`, `curl -u deploy:${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u "deploy":${ARGV_SECRET} https://host/x`, `curl -u "deploy":${REDACTION_PLACEHOLDER} https://host/x`],
    [`curl -u "deploy:${ARGV_SECRET} word" https://host/x`, `curl -u "deploy:${REDACTION_PLACEHOLDER}" https://host/x`],
    [`curl -u 'deploy:${ARGV_SECRET} word' https://host/x`, `curl -u 'deploy:${REDACTION_PLACEHOLDER}' https://host/x`],
    // Each occurrence in one command line.
    [`cli --token ${ARGV_SECRET} -u a:${ARGV_SECRET}`, `cli --token ${REDACTION_PLACEHOLDER} -u a:${REDACTION_PLACEHOLDER}`],
  ];
  for (const [text, expected] of cases) {
    const redacted = redactCredentials(text);
    expect(redacted, text).not.toContain(ARGV_SECRET);
    expect(redacted, text).toContain(REDACTION_PLACEHOLDER);
    expect(redacted, text).toBe(expected);
  }
});

it('keeps argv near misses unchanged: a flag with no credential value, a short, symbol-only or numeric -u part, an id pair', () => {
  for (const kept of [
    '--token --verbose',
    'node cli.js --token',
    'node cli.js --token --verbose build',
    'docker run -u 1000:1000 image',
    'docker run -u 165536:165536 image',
    'curl -u deploy:1234567 https://host/x',
    'curl -u "deploy:1234567" https://host/x',
    'curl -u \'deploy:1234567\' https://host/x',
    'docker exec -u alice bash',
    'git push -u origin main',
    'git push -u origin HEAD:refs/heads/main',
    'cli --token abc12',
    'cli --token ******',
    'cli --tokenize abcdefgh',
    'cli --token-file /tmp/token-file',
    'curl -H Authorization: token',
    'curl -H Authorization: token --verbose',
    'curl -H Authorization: token abc',
    'curl -H Authorization: tokens abcdefghij',
    'cli -u:abcdefghij',
  ]) expect(redactCredentials(kept), kept).toBe(kept);
});

it('redacts a command line once: a redacted argv redacts to itself', () => {
  for (const text of [
    `curl -H Authorization: Bearer ${ARGV_SECRET} --token ${ARGV_SECRET} -u me:${ARGV_SECRET} -H Authorization: token ${ARGV_SECRET} https://me:${ARGV_SECRET}@host/x`,
    `cli --token=${ARGV_SECRET} -H PRIVATE-TOKEN: ${ARGV_SECRET}`,
  ]) {
    const once = redactCredentials(text);
    expect(once).not.toContain(ARGV_SECRET);
    expect(redactCredentials(once)).toBe(once);
  }
});
