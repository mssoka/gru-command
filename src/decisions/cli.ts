#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_DECISION_PROFILE,
  effectiveDecisionProviders,
  loadConfig,
  ConfigError,
  instanceDirFromEnv,
} from '../config.js';
import { decisionsConfigTemplate } from './config-template.js';
import {
  parseCredentialStdin,
  resolveCredential,
  writeCredential,
} from './credentials.js';
import { CREDENTIAL_SLOTS, KEYLESS_CREDENTIAL, type CredentialSlot } from './profile.js';
import { checkDecisionProfile, DecisionRuntime } from './runtime.js';

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, code = 2): number {
  process.stderr.write(`${message}\n`);
  return code;
}

async function readStdin(maxBytes = 16_384): Promise<string> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    seen += buffer.length;
    if (seen > maxBytes) throw new Error('credential input is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Offline, sanitised status: legacy top-level fields plus one entry per
 * effective profile (built-ins included). The top-level credential fields
 * describe the DEFAULT profile's slot (today's single-slot semantics), so
 * an overridden default reports its own slot — never hardcoded OpenRouter.
 * No key material ever leaves. */
function offlineStatus(): number {
  const config = loadConfig();
  const effective = effectiveDecisionProviders(config.decisions);
  const defaultSlot = effective[DEFAULT_DECISION_PROFILE]?.credential ?? 'openrouter';
  const credential =
    defaultSlot === KEYLESS_CREDENTIAL
      ? { state: 'present' as const, source: 'none' as const }
      : resolveCredential(config.instanceDir, process.env, defaultSlot);
  const profiles = Object.entries(effective).map(([name, profile]) => {
    if (profile.credential === KEYLESS_CREDENTIAL) {
      return {
        name,
        protocol: profile.protocol,
        endpoint: profile.endpoint,
        model: profile.model,
        credential: KEYLESS_CREDENTIAL,
        credential_state: 'present',
        credential_source: 'none',
      };
    }
    const resolved = resolveCredential(config.instanceDir, process.env, profile.credential);
    return {
      name,
      protocol: profile.protocol,
      endpoint: profile.endpoint,
      model: profile.model,
      credential: profile.credential,
      credential_state: resolved.state,
      credential_source: resolved.source,
    };
  });
  json({
    enabled: config.decisions.jev.enabled,
    credential_present: credential.state === 'present',
    credential_source: credential.source,
    credential_state: credential.state,
    profiles,
  });
  return 0;
}

async function check(profileName: string | null, asJson: boolean): Promise<number> {
  const config = loadConfig();
  const name = profileName ?? DEFAULT_DECISION_PROFILE;
  if (profileName === null) {
    // Default profile: the full runtime startup probe (existing behavior).
    if (!config.decisions.jev.enabled) {
      if (asJson) json({ ok: true, status: 'disabled', reason: null });
      else process.stdout.write(`${name}: disabled (the [decisions] master switch is off)\n`);
      return 0;
    }
    const runtime = new DecisionRuntime(config.decisions, {
      instanceDir: config.instanceDir,
      watchConfig: false,
    });
    try {
      const status = await runtime.start();
      const ok = status.status === 'ready';
      if (asJson) json({ ok, status: status.status, reason: status.reason });
      else process.stdout.write(`${name}: ${status.status}${status.reason !== null ? ` (${status.reason})` : ''}\n`);
      return ok ? 0 : 1;
    } finally {
      runtime.dispose();
    }
  }
  // A named profile validates its existence FIRST — a master-switch-off
  // check of a misspelled profile is a failed check, not a clean disabled.
  const result = await checkDecisionProfile(config.decisions, name, {
    instanceDir: config.instanceDir,
    env: process.env,
  });
  if (asJson) json({ ok: result.ok, status: result.status, reason: result.reason, profile: result.profile });
  else {
    process.stdout.write(
      `${name}: ${result.status}${result.reason !== null ? ` (${result.reason})` : ''}${result.model !== null ? ` model=${result.model}` : ''}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

/** Parse `check` flags: optional `--json` and optional `--profile <name>`,
 * in any order. */
function parseCheckArgs(rest: readonly string[]): { profile: string | null; json: boolean } | string {
  let profile: string | null = null;
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      asJson = true;
    } else if (arg === '--profile') {
      const value = rest[i + 1];
      if (value === undefined) return 'usage: check [--json] [--profile <name>]';
      profile = value;
      i += 1;
    } else {
      return 'usage: check [--json] [--profile <name>]';
    }
  }
  return { profile, json: asJson };
}

function parseSlot(rest: readonly string[]): { readonly ok: true; readonly slot: CredentialSlot } | { readonly ok: false; readonly message: string } {
  // `credentials set --stdin` (legacy, openrouter slot) or
  // `credentials set --slot <name> --stdin`.
  if (rest[0] !== 'set') {
    return { ok: false, message: 'usage: credentials set [--slot <name>] --stdin (API keys are never accepted in argv)' };
  }
  const args = rest.slice(1);
  if (args.length === 1 && args[0] === '--stdin') return { ok: true, slot: 'openrouter' };
  if (args.length === 3 && args[0] === '--slot' && args[2] === '--stdin') {
    const slot: string = args[1] ?? '';
    if (!(CREDENTIAL_SLOTS as readonly string[]).includes(slot)) {
      return { ok: false, message: `unknown credential slot "${slot}" (valid: ${CREDENTIAL_SLOTS.join(', ')})` };
    }
    return { ok: true, slot: slot as CredentialSlot };
  }
  return { ok: false, message: 'usage: credentials set [--slot <name>] --stdin (API keys are never accepted in argv)' };
}

export async function runDecisionCli(argv: readonly string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'config-template') {
      let enabled = false;
      if (rest.length > 0) {
        if (rest.length !== 2 || rest[0] !== '--enabled' || (rest[1] !== 'true' && rest[1] !== 'false')) {
          return fail('usage: config-template [--enabled true|false]');
        }
        enabled = rest[1] === 'true';
      }
      process.stdout.write(decisionsConfigTemplate(enabled));
      return 0;
    }
    if (command === 'credentials') {
      const parsed = parseSlot(rest);
      if (!parsed.ok) return fail(parsed.message);
      const key = parseCredentialStdin(await readStdin());
      writeCredential(instanceDirFromEnv(), key, parsed.slot);
      json({ ok: true });
      return 0;
    }
    if (command === 'status') {
      if (rest.length !== 1 || rest[0] !== '--json') return fail('usage: status --json');
      return offlineStatus();
    }
    if (command === 'check') {
      const parsed = parseCheckArgs(rest);
      if (typeof parsed === 'string') return fail(parsed);
      return await check(parsed.profile, parsed.json);
    }
    return fail('usage: <config-template|credentials|status|check> (secrets are stdin-only)');
  } catch (error) {
    if (error instanceof ConfigError) return fail('configuration is invalid; fix config.toml and retry', 1);
    const message = error instanceof Error && /credential|profile/i.test(error.message)
      ? error.message
      : 'decision command failed; inspect local file permissions/config and retry';
    return fail(message, 1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDecisionCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('decision command failed\n');
      process.exitCode = 1;
    });
}
