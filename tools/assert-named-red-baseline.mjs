#!/usr/bin/env node
/**
 * Generic fail-before leg classifier (CLI over the shared named-assertion
 * classifier): requires every named test to have failed as a BEHAVIORAL
 * assertion in a parseable Vitest JSON report. Import/collection/setup
 * signatures, a missing named case, or a leg with no failures break the
 * claim (exit 2) instead of proving it.
 *
 * usage: assert-named-red-baseline.mjs <label> <results.json> <title> [<title>...]
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { assertFormalVerdictsBaselineLeg } from './assert-formal-verdicts-baseline.mjs';

const [label, path, ...titles] = process.argv.slice(2);
if (label === undefined || path === undefined || titles.length === 0) {
  process.stderr.write('usage: assert-named-red-baseline.mjs <label> <results.json> <title> [<title>...]\n');
  process.exitCode = 2;
} else {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    process.stdout.write(`${assertFormalVerdictsBaselineLeg(label, report, titles)}\n`);
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
