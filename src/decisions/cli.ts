#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError, instanceDirFromEnv } from '../config.js';
import { decisionsConfigTemplate } from './config-template.js';
import {
  parseCredentialStdin,
  resolveCredential,
  writeCredential,
} from './credentials.js';
import { DecisionRuntime } from './runtime.js';

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

function offlineStatus(): number {
  const config = loadConfig();
  const credential = resolveCredential(config.instanceDir);
  json({
    enabled: config.decisions.jev.enabled,
    credential_present: credential.state === 'present',
    credential_source: credential.source,
    credential_state: credential.state,
  });
  return 0;
}

async function check(): Promise<number> {
  const config = loadConfig();
  if (!config.decisions.jev.enabled) {
    json({ ok: true, status: 'disabled', reason: null });
    return 0;
  }
  const runtime = new DecisionRuntime(config.decisions, {
    instanceDir: config.instanceDir,
    watchConfig: false,
  });
  try {
    const status = await runtime.start();
    const ok = status.status === 'ready';
    json({ ok, status: status.status, reason: status.reason });
    return ok ? 0 : 1;
  } finally {
    runtime.dispose();
  }
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
      if (rest.length !== 2 || rest[0] !== 'set' || rest[1] !== '--stdin') {
        return fail('usage: credentials set --stdin (API keys are never accepted in argv)');
      }
      const key = parseCredentialStdin(await readStdin());
      writeCredential(instanceDirFromEnv(), key);
      json({ ok: true });
      return 0;
    }
    if (command === 'status') {
      if (rest.length !== 1 || rest[0] !== '--json') return fail('usage: status --json');
      return offlineStatus();
    }
    if (command === 'check') {
      if (rest.length !== 1 || rest[0] !== '--json') return fail('usage: check --json');
      return await check();
    }
    return fail('usage: <config-template|credentials|status|check> (secrets are stdin-only)');
  } catch (error) {
    if (error instanceof ConfigError) return fail('configuration is invalid; fix config.toml and retry', 1);
    const message = error instanceof Error && /credential/i.test(error.message)
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
