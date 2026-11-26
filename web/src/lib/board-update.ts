/**
 * The board's Update button (owner request 2026-11-26): the same update a
 * terminal `gru update` runs, one press from the deploy reading. The
 * service updates itself — POST /api/roll with `now`: pull main, rebuild
 * while the old build keeps serving, then restart at once, cutting the
 * turns still running (boot recovery resumes them). The page that pressed
 * it follows the update record (GET /api/roll) until the relaunched
 * service marks it done, then reloads into the new board.
 *
 * Pure, so every step the deploy reading can show is unit-testable without
 * a DOM or a clock.
 */

import { restartPending } from './board-health.js';
import type { BuildView } from './board-protocol.js';

export type RollPhaseView = 'preflight' | 'drain' | 'swap' | 'verify' | 'done' | 'failed';

/** The part of the service's update record the button reads. */
export interface RollView {
  readonly rollId: string;
  readonly phase: RollPhaseView;
  readonly toSha: string | null;
  /** Why the update stopped (the old build keeps serving). */
  readonly error: { readonly phase: string; readonly detail: string } | null;
}

const PHASES: readonly string[] = ['preflight', 'drain', 'swap', 'verify', 'done', 'failed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `roll` field of a POST/GET /api/roll answer: null before the first
 * update; throws on a record the button cannot read, naming the field. */
export function parseRollView(value: unknown): RollView | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('update record is not an object');
  const { rollId, phase, toSha, error } = value;
  if (typeof rollId !== 'string' || rollId === '') throw new Error('update record has no rollId');
  if (typeof phase !== 'string' || !PHASES.includes(phase)) throw new Error(`update record has an unknown phase: ${String(phase)}`);
  if (toSha !== null && typeof toSha !== 'string') throw new Error('update record toSha is not a string');
  let parsedError: RollView['error'] = null;
  if (error !== null && error !== undefined) {
    if (!isRecord(error) || typeof error['phase'] !== 'string' || typeof error['detail'] !== 'string') {
      throw new Error('update record error is malformed');
    }
    parsedError = { phase: error['phase'], detail: error['detail'] };
  }
  return { rollId, phase: phase as RollPhaseView, toSha: toSha ?? null, error: parsedError };
}

/** A POST/GET /api/roll answer body: `{ roll }`. */
export function parseRollReply(body: unknown): RollView | null {
  if (!isRecord(body)) throw new Error('the update reply is not an object');
  return parseRollView(body['roll'] ?? null);
}

/** Where the update this page started stands.
 *
 * `starting` carries the update record the service held before the press
 * (`previousRollId`, null = none yet), so a press whose POST got no answer
 * never mistakes that older record (a done from last week) for its own.
 * `running.rollId` is the update being followed, once known.
 * `running.lostContact`: the last read got no answer — after the swap that
 * is the restart itself. */
export type UpdateFollow =
  | { readonly step: 'idle' }
  | { readonly step: 'starting'; readonly previousRollId: string | null }
  | {
      readonly step: 'running';
      readonly rollId: string | null;
      readonly previousRollId: string | null;
      readonly phase: RollPhaseView | null;
      readonly lostContact: boolean;
    }
  | { readonly step: 'done'; readonly rollId: string }
  | { readonly step: 'failed'; readonly detail: string };

export const UPDATE_IDLE: UpdateFollow = { step: 'idle' };

/** How long the page follows one update before it says it lost track
 * (the CLI's own follow bound: npm ci + builds can take minutes). */
export const UPDATE_FOLLOW_TIMEOUT_MS = 30 * 60_000;
/** Poll cadence for GET /api/roll while an update runs. */
export const UPDATE_POLL_MS = 2_000;

/** Fold one read of the update record into the follow state.
 *
 * - The record the service held before the press is no news while this
 *   page does not yet know its own update.
 * - A record for another update (someone ran `gru update` meanwhile) is
 *   followed too: it is the update the service is doing now. */
export function followRoll(current: UpdateFollow, roll: RollView | null): UpdateFollow {
  if (current.step !== 'starting' && current.step !== 'running') return current;
  const previousRollId = current.previousRollId;
  const known = current.step === 'running' ? current.rollId : null;
  if (roll === null || (known === null && roll.rollId === previousRollId)) {
    return { step: 'running', rollId: known, previousRollId, phase: null, lostContact: false };
  }
  if (roll.phase === 'failed') {
    return { step: 'failed', detail: roll.error?.detail ?? `the update stopped in ${roll.error?.phase ?? 'an unknown phase'}` };
  }
  if (roll.phase === 'done') return { step: 'done', rollId: roll.rollId };
  return { step: 'running', rollId: roll.rollId, previousRollId, phase: roll.phase, lostContact: false };
}

/** A read that got no answer (the service is restarting, or the network
 * dropped): keep following, and say so. */
export function lostContact(current: UpdateFollow): UpdateFollow {
  if (current.step !== 'starting' && current.step !== 'running') return current;
  return {
    step: 'running',
    rollId: current.step === 'running' ? current.rollId : null,
    previousRollId: current.previousRollId,
    phase: current.step === 'running' ? current.phase : null,
    lostContact: true,
  };
}

export const UPDATE_TIMED_OUT_DETAIL = 'no word from the update for 30 minutes — check gru status and gru logs';

export interface UpdateControl {
  /** Show the Update button. */
  readonly offer: boolean;
  /** What the deploy reading says about the update; null = nothing. */
  readonly status: string | null;
  readonly tone: 'work' | 'alert' | null;
}

/** The deploy reading's update control. The button shows whenever the
 * deploy reading flags (a newer release, or the build is behind main) and
 * no update from this page is under way; a failed update offers it again
 * beside the reason. */
export function updateControl(follow: UpdateFollow, build: BuildView | null | undefined): UpdateControl {
  const pending = restartPending(build);
  switch (follow.step) {
    case 'idle':
      return { offer: pending, status: null, tone: null };
    case 'starting':
      return { offer: false, status: 'updating…', tone: 'work' };
    case 'running': {
      if (follow.lostContact) return { offer: false, status: 'restarting — waiting for the service…', tone: 'work' };
      if (follow.phase === 'drain' || follow.phase === 'swap' || follow.phase === 'verify') {
        return { offer: false, status: 'restarting…', tone: 'work' };
      }
      return { offer: false, status: 'updating: pulling and building…', tone: 'work' };
    }
    case 'done':
      return { offer: false, status: 'updated — reloading…', tone: 'work' };
    case 'failed':
      return { offer: pending, status: `update failed: ${follow.detail}`, tone: 'alert' };
  }
}

/** The button's long explanation (title and accessible name). It starts
 * with the visible label, so a voice user saying "Update Now" finds it. */
export const UPDATE_BUTTON_TITLE =
  'Update Now: pull main, rebuild, and restart the service at once, as gru update does. Running turns are cut and resume after the restart.';
