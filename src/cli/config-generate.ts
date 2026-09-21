#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { instanceDirFromEnv } from '../config.js';
import { parseAnswers } from '../wizard/answers.js';
import { writeInstanceConfig } from '../wizard/steps.js';

const USAGE = 'usage: node dist/cli/config-generate.js [--force]';

export function runConfigGenerate(argv: readonly string[]): number {
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`config-generate: unknown argument: ${arg}\n${USAGE}\n`);
      return 2;
    }
  }

  const instanceDir = instanceDirFromEnv();
  const answers = parseAnswers('{}');
  const result = writeInstanceConfig({ instanceDir, answers, force });
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
