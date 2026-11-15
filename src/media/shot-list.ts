import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { operationalDirectoryFor } from '../artifacts/context.js';
import { MEDIA_MAX_PER_HEAD, MediaError, validateCaption, type MediaRole } from './store.js';

/**
 * The shot list (owner ruling 2026-11-15, Q1 option C: "minion directs, GC
 * films"). The minion writes `shot-list.json` into its private operational
 * artifacts folder; GC's camera films it at the lane's exact committed head
 * and re-shoots when the head moves.
 *
 *   {
 *     "version": 1,
 *     "shots": [
 *       {
 *         "id": "ready-row",
 *         "proves": "AC2: a ready PR row shows its captures",
 *         "kind": "screenshot",                 // or "clip" (WebM)
 *         "viewports": ["desktop", "mobile"],   // presets, or {"width": 1280, "height": 800}
 *         "steps": [
 *           {"open": "/board"},
 *           {"click": "[data-tab=for-you]"},
 *           {"type": "#filter", "text": "media"},
 *           {"wait_for_text": "What it looks like"}
 *         ],
 *         "compare": "base"                     // optional: also film the merge base
 *       },
 *       {"id": "sign-in", "proves": "AC3: …", "skip": "needs a real GitHub sign-in"}
 *     ]
 *   }
 *
 * A list whose change has nothing to film says so instead: `{"version": 1,
 * "skip": "<why nothing a person sees changed>"}`. Skip reasons are what the
 * owner reads when a diff touches `[capture] paths` without media (ruling Q4).
 *
 * The file is the minion's input, so every field is validated fail-loud with
 * a named reason; the camera never guesses what a malformed list meant.
 */

export const SHOT_LIST_FILE = 'shot-list.json';
export const SHOT_LIST_MAX_BYTES = 64 * 1024;
export const SHOT_STEPS_MAX = 20;
export const SHOT_VIEWPORTS_MAX = 3;
export const SHOT_PROVES_MAX_CHARS = 150;
export const SHOT_SKIP_MAX_CHARS = 300;
export const SHOT_TEXT_MAX_CHARS = 500;
export const SHOT_SELECTOR_MAX_CHARS = 300;
export const SHOT_VIEWPORT_MIN = 320;
export const SHOT_VIEWPORT_MAX_WIDTH = 3840;
export const SHOT_VIEWPORT_MAX_HEIGHT = 2160;

export const VIEWPORT_PRESETS: Readonly<Record<string, { readonly width: number; readonly height: number }>> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

export type ShotKind = 'screenshot' | 'clip';

export type ShotStep =
  | { readonly action: 'open'; readonly path: string }
  | { readonly action: 'click'; readonly selector: string }
  | { readonly action: 'type'; readonly selector: string; readonly text: string }
  | { readonly action: 'wait_for_text'; readonly text: string };

export interface ShotViewport {
  /** The preset name, or `<width>x<height>`. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface Shot {
  readonly id: string;
  /** The acceptance item this shot proves; it becomes the caption. */
  readonly proves: string;
  /** Null when the shot is skipped. */
  readonly kind: ShotKind | null;
  readonly viewports: readonly ShotViewport[];
  readonly steps: readonly ShotStep[];
  readonly compare: 'base' | null;
  /** Why this shot is not filmed; null when it is. */
  readonly skip: string | null;
}

export interface ShotList {
  readonly version: 1;
  readonly shots: readonly Shot[];
  /** Why the whole change needs no media; null when shots are listed. */
  readonly skip: string | null;
  /** sha256 of the file's exact bytes: a changed list is a new script. */
  readonly sha256: string;
}

/** One file the camera owes for a list: a shot at one viewport, after or
 * before (the merge base, for a shot that asks to compare). */
export interface PlannedCapture {
  readonly shotId: string;
  readonly role: MediaRole;
  readonly kind: ShotKind;
  readonly viewport: ShotViewport;
  readonly steps: readonly ShotStep[];
  readonly caption: string;
}

export type ShotListErrorCode = 'shot_list_unreadable' | 'shot_list_invalid' | 'shot_list_over_limit';

/** A shot list GC refuses, with a stable code and a reason the minion can act on. */
export class ShotListError extends Error {
  constructor(readonly code: ShotListErrorCode, message: string) {
    super(message);
    this.name = 'ShotListError';
  }
}

function invalid(where: string, reason: string): ShotListError {
  return new ShotListError('shot_list_invalid', `${SHOT_LIST_FILE} ${where} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(where, `has unknown key "${key}" (valid: ${keys.join(', ')})`);
  }
}

/** One line of honest text: the caption rules (no control, invisible or
 * direction characters), bounded. */
function line(value: unknown, where: string, max: number): string {
  if (typeof value !== 'string') throw invalid(where, 'must be a string');
  let text: string;
  try {
    text = validateCaption(value);
  } catch (error) {
    if (error instanceof MediaError) throw invalid(where, error.message.replace(/^caption /u, ''));
    throw error;
  }
  if ([...text].length > max) throw invalid(where, `must be at most ${max} characters`);
  return text;
}

/** Selectors and typed text: one line, no control characters, bounded. */
function plain(value: unknown, where: string, max: number): string {
  if (typeof value !== 'string' || value === '') throw invalid(where, 'must be a non-empty string');
  if ([...value].length > max) throw invalid(where, `must be at most ${max} characters`);
  if (/\p{Cc}/u.test(value)) throw invalid(where, 'must be one line without control characters');
  return value;
}

function parseStep(value: unknown, where: string): ShotStep {
  if (!isRecord(value)) throw invalid(where, 'must be an object such as {"open": "/"} or {"click": "#save"}');
  const actions = ['open', 'click', 'type', 'wait_for_text'].filter((key) => key in value);
  if (actions.length !== 1) throw invalid(where, 'must name exactly one of open, click, type, wait_for_text');
  const action = actions[0]!;
  onlyKeys(value, action === 'type' ? ['type', 'text'] : [action], where);
  if (action === 'open') {
    const path = plain(value['open'], `${where}.open`, SHOT_TEXT_MAX_CHARS);
    // A path on the app, never a URL: the camera's browser opens only the
    // lane's loopback app.
    if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/u.test(path)) {
      throw invalid(`${where}.open`, `must be a path on the app starting with one "/" (no scheme, host, spaces or backslashes), got ${JSON.stringify(path)}`);
    }
    return { action: 'open', path };
  }
  if (action === 'click') return { action: 'click', selector: plain(value['click'], `${where}.click`, SHOT_SELECTOR_MAX_CHARS) };
  if (action === 'type') {
    return {
      action: 'type',
      selector: plain(value['type'], `${where}.type`, SHOT_SELECTOR_MAX_CHARS),
      text: plain(value['text'], `${where}.text`, SHOT_TEXT_MAX_CHARS),
    };
  }
  return { action: 'wait_for_text', text: plain(value['wait_for_text'], `${where}.wait_for_text`, SHOT_TEXT_MAX_CHARS) };
}

function parseViewport(value: unknown, where: string): ShotViewport {
  if (typeof value === 'string') {
    const preset = Object.hasOwn(VIEWPORT_PRESETS, value) ? VIEWPORT_PRESETS[value] : undefined;
    if (preset === undefined) throw invalid(where, `names no preset (valid: ${Object.keys(VIEWPORT_PRESETS).join(', ')}, or {"width": …, "height": …})`);
    return { name: value, ...preset };
  }
  if (!isRecord(value)) throw invalid(where, 'must be a preset name or {"width": …, "height": …}');
  onlyKeys(value, ['width', 'height'], where);
  const width = value['width'];
  const height = value['height'];
  if (typeof width !== 'number' || !Number.isInteger(width) || width < SHOT_VIEWPORT_MIN || width > SHOT_VIEWPORT_MAX_WIDTH) {
    throw invalid(`${where}.width`, `must be an integer from ${SHOT_VIEWPORT_MIN} to ${SHOT_VIEWPORT_MAX_WIDTH}`);
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height < SHOT_VIEWPORT_MIN || height > SHOT_VIEWPORT_MAX_HEIGHT) {
    throw invalid(`${where}.height`, `must be an integer from ${SHOT_VIEWPORT_MIN} to ${SHOT_VIEWPORT_MAX_HEIGHT}`);
  }
  return { name: `${width}x${height}`, width, height };
}

function parseShot(value: unknown, index: number, seen: Set<string>): Shot {
  const where = `shots[${index}]`;
  if (!isRecord(value)) throw invalid(where, 'must be an object');
  const id = value['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id)) {
    throw invalid(`${where}.id`, 'must be 1–40 lowercase letters, digits or dashes, starting with a letter or digit');
  }
  if (seen.has(id)) throw invalid(`${where}.id`, `repeats the shot id "${id}"`);
  seen.add(id);
  const proves = line(value['proves'], `${where}.proves`, SHOT_PROVES_MAX_CHARS);
  if (value['skip'] !== undefined) {
    onlyKeys(value, ['id', 'proves', 'skip'], `${where} (skipped)`);
    return { id, proves, kind: null, viewports: [], steps: [], compare: null, skip: line(value['skip'], `${where}.skip`, SHOT_SKIP_MAX_CHARS) };
  }
  onlyKeys(value, ['id', 'proves', 'kind', 'viewports', 'steps', 'compare'], where);
  const kind = value['kind'];
  if (kind !== 'screenshot' && kind !== 'clip') throw invalid(`${where}.kind`, 'must be "screenshot" or "clip"');
  const rawViewports = value['viewports'];
  if (!Array.isArray(rawViewports) || rawViewports.length === 0 || rawViewports.length > SHOT_VIEWPORTS_MAX) {
    throw invalid(`${where}.viewports`, `must list 1–${SHOT_VIEWPORTS_MAX} viewports`);
  }
  const viewports = rawViewports.map((viewport, at) => parseViewport(viewport, `${where}.viewports[${at}]`));
  const names = new Set<string>();
  for (const viewport of viewports) {
    if (names.has(viewport.name)) throw invalid(`${where}.viewports`, `repeats ${viewport.name}`);
    names.add(viewport.name);
  }
  const rawSteps = value['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > SHOT_STEPS_MAX) {
    throw invalid(`${where}.steps`, `must list 1–${SHOT_STEPS_MAX} steps`);
  }
  const steps = rawSteps.map((step, at) => parseStep(step, `${where}.steps[${at}]`));
  if (steps[0]!.action !== 'open') throw invalid(`${where}.steps[0]`, 'must be an open step: a shot starts on a page of the app');
  const compare = value['compare'];
  if (compare !== undefined && compare !== 'base') throw invalid(`${where}.compare`, 'must be "base" when present');
  return { id, proves, kind, viewports, steps, compare: compare === 'base' ? 'base' : null, skip: null };
}

/** Parse and validate shot-list text. Throws {@link ShotListError}. */
export function parseShotList(text: string): ShotList {
  const sha256 = createHash('sha256').update(text).digest('hex');
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ShotListError('shot_list_invalid', `${SHOT_LIST_FILE} is not valid JSON: ${String(error instanceof Error ? error.message : error)}`);
  }
  if (!isRecord(raw)) throw invalid('', 'must be a JSON object');
  onlyKeys(raw, ['version', 'shots', 'skip'], 'top level');
  if (raw['version'] !== 1) throw invalid('version', 'must be 1');
  const rawShots = raw['shots'] ?? [];
  if (!Array.isArray(rawShots)) throw invalid('shots', 'must be an array');
  if (raw['skip'] !== undefined) {
    if (rawShots.length > 0) throw invalid('skip', 'says the change needs no media, so shots must be empty');
    return { version: 1, shots: [], skip: line(raw['skip'], 'skip', SHOT_SKIP_MAX_CHARS), sha256 };
  }
  if (rawShots.length === 0) throw invalid('shots', 'must list at least one shot, or give a top-level "skip" reason instead');
  if (rawShots.length > MEDIA_MAX_PER_HEAD) throw invalid('shots', `may list at most ${MEDIA_MAX_PER_HEAD} shots`);
  const seen = new Set<string>();
  const shots = rawShots.map((shot, index) => parseShot(shot, index, seen));
  const files = shots.reduce((sum, shot) => sum + shot.viewports.length * (shot.compare === 'base' ? 2 : 1), 0);
  if (files > MEDIA_MAX_PER_HEAD) {
    throw new ShotListError('shot_list_over_limit',
      `${SHOT_LIST_FILE} plans ${files} captures (each shot × its viewports, twice with compare); a head holds at most ${MEDIA_MAX_PER_HEAD}`);
  }
  return { version: 1, shots, skip: null, sha256 };
}

/** The captures a list owes, in the order they are filmed and shown: for each
 * shot, its before captures (compare) and then its after captures. */
export function planCaptures(list: ShotList): readonly PlannedCapture[] {
  const plans: PlannedCapture[] = [];
  for (const shot of list.shots) {
    if (shot.skip !== null || shot.kind === null) continue;
    const roles: readonly MediaRole[] = shot.compare === 'base' ? ['before', 'after'] : ['after'];
    for (const role of roles) {
      for (const viewport of shot.viewports) {
        const parts = [shot.proves];
        if (shot.viewports.length > 1) parts.push(viewport.name);
        if (role === 'before') parts.push('before (merge base)');
        plans.push({ shotId: shot.id, role, kind: shot.kind, viewport, steps: shot.steps, caption: parts.join(' · ') });
      }
    }
  }
  return plans;
}

/** The reason the change owes no media, when the list gives one: the
 * top-level skip, or every shot skipped (their reasons joined). */
export function shotListSkipReason(list: ShotList): string | null {
  if (list.skip !== null) return list.skip;
  if (list.shots.length > 0 && list.shots.every((shot) => shot.skip !== null)) {
    return list.shots.map((shot) => `${shot.id}: ${shot.skip ?? ''}`).join('; ');
  }
  return null;
}

/** Where the job's shot list lives: its private operational artifacts folder. */
export function shotListPath(dataDir: string, repoPath: string, jobId: string): string {
  return join(operationalDirectoryFor(dataDir, repoPath, jobId), SHOT_LIST_FILE);
}

/** Read and validate the job's shot list. Null when there is none. A file
 * that is a symlink, not a regular file, or over the size cap is refused. */
export function readShotList(path: string): ShotList | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ShotListError('shot_list_unreadable', `${SHOT_LIST_FILE} cannot be opened (${code ?? String(error)}): write it as a plain file, not a link`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ShotListError('shot_list_unreadable', `${SHOT_LIST_FILE} is not a regular file`);
    if (stat.size > SHOT_LIST_MAX_BYTES) {
      throw new ShotListError('shot_list_unreadable', `${SHOT_LIST_FILE} is ${stat.size} bytes; the limit is ${SHOT_LIST_MAX_BYTES}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return parseShotList(bytes.subarray(0, offset).toString('utf-8'));
  } finally {
    closeSync(fd);
  }
}
