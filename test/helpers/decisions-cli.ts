import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Test-only executable implementing the stable sibling CLI contract. */
export function writeDecisionsCliFixture(root: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'decisions-cli.mjs');
  writeFileSync(
    path,
    [
      "import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "const home = process.env.GRU_COMMAND_HOME ?? '';",
      "const credential = join(home, 'credentials', 'openrouter.key');",
      "if (process.env.JEV_FIXTURE_LOG) appendFileSync(process.env.JEV_FIXTURE_LOG, args.join(' ') + '\\n');",
      "if (process.env.JEV_FIXTURE_ENV_LOG) appendFileSync(process.env.JEV_FIXTURE_ENV_LOG, process.env.OPENROUTER_API_KEY ? 'present\\n' : 'absent\\n');",
      "if (args[0] === 'config-template') {",
      "  const enabled = args.includes('true');",
      "  if (process.env.JEV_FIXTURE_ACTIVE_CONFIG === '1') {",
      `    process.stdout.write('[decisions.jev]\\nenabled = ' + enabled + '\\nmodel = "~typesafe/jev-latest"\\nendpoint = "https://openrouter.ai/api/alpha/decisions"\\ntimeout_ms = 2000\\n[decisions.thresholds.read_only]\\nact = 0.6\\nconfirm = 0.4\\nrequire_confirm_on_act = false\\n[decisions.thresholds.operational]\\nact = 0.75\\nconfirm = 0.55\\nrequire_confirm_on_act = false\\n[decisions.thresholds.destructive]\\nact = 0.85\\nconfirm = 0.7\\nrequire_confirm_on_act = true\\n');`,
      "  } else { process.stdout.write('# TEST-ONLY PRE-JEV SCHEMA FRAGMENT\\n# [decisions.jev]\\n# enabled = ' + enabled + '\\n'); }",
      "} else if (args[0] === 'status') {",
      "  let present = false; try { present = readFileSync(credential, 'utf-8').trim() !== ''; } catch {}",
      "  const env = Boolean(process.env.OPENROUTER_API_KEY);",
      "  if (process.env.JEV_FIXTURE_BAD_STATUS === '1') process.stdout.write('{not-json');",
      "  else process.stdout.write(JSON.stringify({enabled:false,credential_present:env || present,credential_source:env ? 'environment' : (present ? 'file' : 'none')}));",
      "} else if (args[0] === 'credentials' && args[1] === 'set' && args[2] === '--stdin') {",
      "  const key = readFileSync(0, 'utf-8').replace(/\\n$/, '');",
      "  if (!key || /[\\r\\n]/.test(key)) { process.stderr.write('invalid credential\\n'); process.exit(2); }",
      "  mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });",
      "  const tmp = credential + '.tmp'; writeFileSync(tmp, key + '\\n', { mode: 0o600 }); renameSync(tmp, credential); chmodSync(credential, 0o600);",
      "  process.stdout.write('{\"ok\":true}');",
      "} else if (args[0] === 'check') {",
      "  const degraded = process.env.JEV_FIXTURE_DEGRADED === '1';",
      "  const ready = process.env.JEV_FIXTURE_READY === '1';",
      "  if (process.env.JEV_FIXTURE_BAD_CHECK === '1') process.stdout.write('{not-json');",
      "  else process.stdout.write(JSON.stringify(degraded ? {ok:false,status:'degraded',reason:'provider_unavailable'} : (ready ? {ok:true,status:'ready',reason:null} : {ok:true,status:'disabled',reason:null})));",
      "  if (degraded) process.exitCode = 1;",
      "} else { process.stderr.write('unsupported fixture command\\n'); process.exit(2); }",
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return path;
}
