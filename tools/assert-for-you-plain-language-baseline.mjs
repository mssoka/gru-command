#!/usr/bin/env node
/**
 * Fail-before classifier for the FOR YOU plain-language standard (issue #570).
 *
 * Two legs prove the claim, each overlaid on an isolated `git archive` of the
 * branch base:
 *
 *   - `boundary` — `test/for-you-plain-language-boundary.test.ts`, written
 *     against modules that exist at the base (the notification center, the
 *     ledger, the decision parser, the attention registry and the web
 *     owner-band). At the base a card with internal vocabulary, an identifier
 *     on its face, no do-nothing line or no recommendation is stored without
 *     complaint, and the notice guidance is one flat sentence — so every named
 *     case REDs BY ASSERTION, never by import.
 *   - `face` — the owner-card face rule in
 *     `web/src/ui/notification-card.test.ts`. At the base a short single-line
 *     detail becomes the card's face context, so the "an owner notice never
 *     promotes its short detail to the face" case REDs by assertion.
 *
 * A collection/setup/import failure, a missing named case or a case that is
 * GREEN at the base exits 2 as FAILS-BEFORE CLAIM BROKEN.
 *
 * usage: assert-for-you-plain-language-baseline.mjs <label> <results.json> <boundary|face>
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { assertNamedRedBaselineLeg } from './assert-formal-verdicts-baseline.mjs';

const SUITE = 'FOR YOU plain language — the owner-card write boundary (#570)';

/** Every named case the pre-change base must fail by AssertionError. */
export const EXPECTED_BOUNDARY_ASSERTIONS = Object.freeze([
  `${SUITE} a typed owner decision whose question uses internal vocabulary is refused at the boundary`,
  `${SUITE} a typed owner decision carrying an identifier on its face is refused and the evidence slot is named`,
  `${SUITE} a question card cannot be posted without saying what happens if the owner does nothing`,
  `${SUITE} a question card cannot be posted without a recommendation or the explicit no-preference form`,
  `${SUITE} an informational notice says nothing is asked of you and what happens if you do nothing`,
]);

export const EXPECTED_FACE_ASSERTIONS = Object.freeze([
  'readable notification card — fixed long-content contract an owner notice never promotes its short detail to the face and keeps it behind Details',
]);

export const LEGS = Object.freeze({
  boundary: EXPECTED_BOUNDARY_ASSERTIONS,
  face: EXPECTED_FACE_ASSERTIONS,
});

/** Classify one leg's Vitest JSON report. Returns the proof line; throws
 * (never a silent pass) when the claim is broken. */
export function assertForYouPlainLanguageBaseline(leg, report) {
  const titles = LEGS[leg];
  if (titles === undefined) throw new Error(`unknown leg "${String(leg)}": expected boundary or face`);
  return assertNamedRedBaselineLeg(`for-you-plain-language (${leg})`, report, titles);
}

const [label, path, leg] = process.argv.slice(2);
if (label === undefined || path === undefined || leg === undefined) {
  process.stderr.write('usage: assert-for-you-plain-language-baseline.mjs <label> <results.json> <boundary|face>\n');
  process.exitCode = 2;
} else {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    process.stdout.write(`${assertForYouPlainLanguageBaseline(leg, report)}\n`);
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
