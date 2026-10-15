#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { instanceDirFromEnv, RUNTIME_IDS, type RuntimeId } from '../config.js';
import { parseAnswers } from '../wizard/answers.js';
import { assertRuntimeCliAvailable } from '../wizard/runtime-cli.js';
import { loadExistingInstanceConfig, seedAnswersFromConfig, writeInstanceConfig } from '../wizard/steps.js';

const USAGE = `usage: node dist/cli/config-generate.js [--force] [--runtime <${RUNTIME_IDS.join('|')}>]`;

export function runConfigGenerate(argv: readonly string[]): number {
  let force = false;
  let runtime: RuntimeId | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--force') force = true;
    else if (arg === '--runtime') {
      const id = argv[i + 1];
      if (id === undefined || !(RUNTIME_IDS as readonly string[]).includes(id)) {
        process.stderr.write(`config-generate: --runtime needs one of: ${RUNTIME_IDS.join(', ')}\n${USAGE}\n`);
        return 2;
      }
      runtime = id as RuntimeId;
      i += 1;
    }
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`config-generate: unknown argument: ${arg}\n${USAGE}\n`);
      return 2;
    }
  }

  const instanceDir = instanceDirFromEnv();
  const answers = parseAnswers(runtime === undefined ? '{}' : JSON.stringify({ runtime }));
  // Preflight with the same seeding writeInstanceConfig applies: an existing
  // config keeps its runtime, so only a runtime this run would newly choose
  // needs its CLI on PATH.
  const prior = loadExistingInstanceConfig(instanceDir);
  const chosen = seedAnswersFromConfig(
    answers,
    prior,
    new Set(runtime === undefined ? [] : ['runtime']),
  ).runtime;
  if (prior === null || prior.runtimes.default !== chosen) assertRuntimeCliAvailable(chosen);
  const result = writeInstanceConfig({ instanceDir, answers, force, prior, ...(runtime === undefined ? {} : { explicitKeys: new Set(['runtime']) }) });
  process.stdout.write(`Wrote complete configuration: ${result.configPath}\n`);
  if (result.backupPath !== null) {
    process.stdout.write(`Previous configuration backed up: ${result.backupPath}\n`);
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
