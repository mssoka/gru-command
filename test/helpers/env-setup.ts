/**
 * Test-suite environment hygiene: the default suite must never
 * authenticate against a real provider, so ambient machine credentials
 * (env-var API keys / tokens) are removed for the whole vitest run.
 * Every model interaction in tests goes through the offline stub
 * provider (see helpers/stub-model.ts). The opt-in smoke test
 * (GRU_COMMAND_SMOKE=1) is exempt — it needs real credentials.
 */
if (process.env['GRU_COMMAND_SMOKE'] !== '1') {
  const AMBIENT_CREDENTIAL = /^(?:[A-Z0-9_]*API_KEY|[A-Z0-9_]*_TOKEN|.*_AUTH_TOKEN)$/;

  for (const key of Object.keys(process.env)) {
    if (AMBIENT_CREDENTIAL.test(key)) {
      delete process.env[key];
    }
  }
  // Known non-suffix-shaped credential variables:
  for (const key of [
    'HF_TOKEN',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_PROFILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    if (key in process.env) delete process.env[key];
  }
}
