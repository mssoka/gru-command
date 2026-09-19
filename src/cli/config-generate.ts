#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { instanceDirFromEnv } from '../config.js';
import { parseAnswers } from '../wizard/answers.js';
import { checkJev } from '../wizard/jev-setup.js';
import { writeInstanceConfig } from '../wizard/steps.js';

const USAGE = 'usage: node dist/cli/config-generate.js [--force] [--enable-jev]';

function repoRootFrom(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), '..', '..');
}

export function runConfigGenerate(argv: readonly string[]): number {
  let force = false;
  let enableJev = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (arg === '--enable-jev') enableJev = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`config-generate: unknown argument: ${arg}\n${USAGE}\n`);
      return 2;
    }
  }

  const repoRoot = repoRootFrom(import.meta.url);
  const instanceDir = instanceDirFromEnv();
  const answers = parseAnswers(JSON.stringify({ jev_enabled: enableJev }));
  const decisionsCliPath = process.env.GRU_COMMAND_TEST_DECISIONS_CLI;
  const result = writeInstanceConfig({
    instanceDir,
    answers,
    repoRoot,
    force,
    decisionsCliPath,
  });
  process.stdout.write(`Wrote complete configuration: ${result.configPath}\n`);
  if (result.backupPath !== null) {
    process.stdout.write(`Previous configuration backed up: ${result.backupPath}\n`);
  }

  if (enableJev) {
    try {
      const check = checkJev({ repoRoot, instanceDir, cliPath: decisionsCliPath });
      if (check.status === 'ready') {
        process.stdout.write('Jev readiness: ready\n');
      } else {
        process.stderr.write(
          `config-generate: Jev readiness: degraded (${check.reason ?? 'unknown'}) — ` +
            'the core service remains usable. Run: node dist/decisions/cli.js check --json\n',
        );
      }
    } catch {
      process.stderr.write(
        'config-generate: Jev readiness: degraded (local CLI unavailable or malformed) — ' +
          'the configuration was written and core service remains usable. ' +
          'Run: node dist/decisions/cli.js check --json\n',
      );
    }
  }
  return 0;
}

function sameFileAfterRealpath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  sameFileAfterRealpath(resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedAsCli) {
  try {
    process.exit(runConfigGenerate(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`config-generate: ${String((error as Error).message)}\n`);
    process.exit(1);
  }
}
