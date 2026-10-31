import { expect, it } from 'vitest';
import { recordsCommand } from '../src/ledger/api.js';
import { redactCredentials } from '../src/redaction.js';

// The `recordsCommand` helper pin, kept in its own file on purpose (#534 R2).
// It is a head-side unit guard for a symbol this script's fail-before baselines
// do not export: `tools/gc-534-red-baseline.sh` and
// `tools/gc-534-r1r2-red-baseline.sh` copy the changed test files over an older
// archived base and skip this file, so a symbol absent there cannot turn their
// legs into a collection/import failure.
it('binds a verification event to its command by the raw line or its masked form, and no other (#534 R2)', () => {
  const raw = 'node verify.mjs pass --token Kq7ZmW3xP9tR2vLd8Nc4';
  const masked = 'node verify.mjs pass --token [REDACTED]';
  // An event recorded since the masking holds the masked line; one recorded before holds the line as listed.
  expect(recordsCommand(masked, raw)).toBe(true);
  expect(recordsCommand(raw, raw)).toBe(true);
  // Another command, a different masked line and a non-string are none of them this command.
  expect(recordsCommand('node verify.mjs fail --token [REDACTED]', raw)).toBe(false);
  expect(recordsCommand(undefined, raw)).toBe(false);
  expect(recordsCommand(null, raw)).toBe(false);
  expect(recordsCommand(7, raw)).toBe(false);
  // An event recorded under an earlier, narrower set of redaction rules (it knew `--token` only) still binds: both
  // sides are masked with today's rules before they are compared.
  expect(recordsCommand('curl --token [REDACTED] -u deploy:Zx5Hn2Bv8Qd4', 'curl --token Kq7ZmW3xP9tR2vLd8Nc4 -u deploy:Zx5Hn2Bv8Qd4')).toBe(true);
  // The event is bound to its run by the line it was written with: a line differing from `raw` only in a masked
  // credential is the same line. (The registry row, not an event, is what identifies a process: its raw-command digest.)
  expect(recordsCommand(masked, raw.replace('Kq7ZmW3xP9tR2vLd8Nc4', 'Zx5Hn2Bv8Qd4Wm7Lt3Pc'))).toBe(true);
  // The masked line binds as it was written, whether or not masking it again would change it: a quoted credential
  // followed directly by `;`, `)` or `|` leaves a placeholder a second pass takes for a value.
  for (const glued of ['cli --token "$NPM_TOKEN";echo done', '(cli --token "$NPM_TOKEN")', 'curl -u deploy:"$PASS";echo', 'cli --token "$NPM_TOKEN"|tee out.log']) {
    expect(recordsCommand(redactCredentials(glued), glued), glued).toBe(true);
  }
  // A command with nothing to mask is its own masked form.
  expect(recordsCommand('npm test', 'npm test')).toBe(true);
  expect(recordsCommand('npm run build', 'npm test')).toBe(false);
});
