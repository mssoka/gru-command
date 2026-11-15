import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventRecord } from '../ledger/api.js';
import { assertDecodableImage, ReviewEvidenceError, sniffImageMediaType } from '../review-inputs/evidence.js';

/**
 * PR media evidence (owner rulings 2026-11-15, PR 1 of 4): screenshots and
 * short clips the crew captures so the owner can SEE a change before merging.
 *
 * This module is the store and the head binding. A capture arrives with the
 * exact commit it shows (`head_sha`), is validated by magic bytes and bounds,
 * hashed, written once into the private media home (`<data_dir>/media/`,
 * 0700/0600), and journaled as one `media.captured` job event. The event is
 * the record: the board and the publisher read captures back from the ledger
 * and select the ones bound to the PR's CURRENT head, so a capture of an older
 * head is shown as superseded, never as current.
 *
 * Bytes are re-hashed on every read. A file that changed after capture is
 * refused (`media_altered`) — never served, never published.
 */

export const MEDIA_CAPTURED_EVENT = 'media.captured';
/** A closed job's local copies were deleted (the PR/MR keeps the published
 * ones; the board shows only live jobs). */
export const MEDIA_SWEPT_EVENT = 'media.swept';

/** GitHub's attachment cap for images and GIFs, and its video cap on the
 * Free plan (paid plans allow 100 MB video). One cap keeps every accepted
 * capture publishable on every plan. */
export const MEDIA_MAX_FILE_BYTES = 10_000_000;
/** Captures accepted per head: enough for before/after pairs at two widths
 * plus a clip, small enough that the PR section stays readable. */
export const MEDIA_MAX_PER_HEAD = 8;
export const MEDIA_CAPTION_MAX_CHARS = 200;

export const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/webm', 'video/mp4'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export type MediaKind = 'image' | 'video';
export const MEDIA_ROLES = ['after', 'before'] as const;
/** `after` shows the change at the head; `before` shows the behavior it
 * replaces (captured for comparison, still submitted at the head). */
export type MediaRole = (typeof MEDIA_ROLES)[number];
/** Who produced the pixels: `minion` for a capture the lane's minion
 * submitted (`POST /api/media`), `gc` for one GC's own camera filmed from the
 * minion's shot list (docs/PR-MEDIA.md, "GC's camera"). */
export type MediaCapturedBy = 'minion' | 'gc';
export const MEDIA_CAPTURED_BY: readonly MediaCapturedBy[] = ['minion', 'gc'];

/** Where a GC capture came from: the camera run, the shot it films and the
 * viewport. Null on a minion's capture. */
export interface MediaShot {
  readonly runId: string;
  readonly shotId: string;
  readonly viewport: string;
  /** How many files the run filmed: a run counts only once all are stored. */
  readonly files: number;
}

const EXTENSIONS: Readonly<Record<MediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

export function mediaExtension(mediaType: MediaType): string {
  return EXTENSIONS[mediaType];
}

export function mediaKind(mediaType: MediaType): MediaKind {
  return mediaType.startsWith('video/') ? 'video' : 'image';
}

/** One stored capture, read back from its `media.captured` event. */
export interface MediaItem {
  readonly id: string;
  readonly jobId: string;
  readonly headSha: string;
  readonly mediaType: MediaType;
  readonly kind: MediaKind;
  readonly role: MediaRole;
  readonly caption: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Path relative to the media home (`<job key>/<id>.<ext>`). */
  readonly file: string;
  readonly capturedBy: MediaCapturedBy;
  /** Set exactly when `capturedBy` is `gc`. */
  readonly shot: MediaShot | null;
  readonly recordedAt: string;
  readonly seq: number;
}

/** A refusal with the HTTP status and stable code the API answers with. */
export class MediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** The ledger slice the store needs (structural, so tests pass plain fakes). */
export interface MediaLedger {
  appendCustomEvent(fields: { kind: string; jobId?: string | null; payload?: unknown }): { readonly seq: number; readonly ts: string };
  listJobEvents(
    jobId: string,
    opts?: { readonly limit?: number; readonly kinds?: readonly string[]; readonly order?: 'asc' | 'desc' },
  ): readonly EventRecord[];
  latestEventByPayloadField(kind: string, field: string, value: string): EventRecord | null;
}

export function mediaRoot(dataDir: string): string {
  return join(dataDir, 'media');
}

/** The job's directory name: a hash, so no job id spelling ever becomes a
 * path component. */
export function mediaJobKey(jobId: string): string {
  return jobKey(jobId);
}

function jobKey(jobId: string): string {
  return createHash('sha256').update(jobId).digest('hex').slice(0, 32);
}

const SHA_RE = /^[0-9a-f]{40}$/u;
/** A camera run id (`cr-<uuid>`). */
export const CAPTURE_RUN_ID_RE = /^cr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const VIEWPORT_NAME_RE = /^(?:[a-z]{1,16}|[0-9]{3,4}x[0-9]{3,4})$/u;
const MEDIA_ID_RE = /^m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isMediaId(value: string): boolean {
  return MEDIA_ID_RE.test(value);
}

export function isFullSha(value: string): boolean {
  return SHA_RE.test(value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end && index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]!);
  return text;
}

/** ISO base-media major brands that are MP4 video. HEIC/AVIF stills, M4A
 * audio, 3GP and QuickTime share the `ftyp` box and are refused. */
const MP4_VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash']);

/** Media identity from magic bytes only — never from a name or a declared
 * type. WebM is the EBML header naming the `webm` doctype; MP4 is an ISO
 * base-media `ftyp` box with a video major brand. Null = unsupported. */
export function sniffMediaType(bytes: Uint8Array): MediaType | null {
  const image = sniffImageMediaType(bytes);
  if (image !== null) return image;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 4, 64).includes('webm') ? 'video/webm' : null;
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    return MP4_VIDEO_BRANDS.has(ascii(bytes, 8, 12)) ? 'video/mp4' : null;
  }
  return null;
}

/** Validate a capture's bytes: non-empty, within the cap, a supported type by
 * magic bytes, and (for images) structurally decodable. */
export function validateMediaBytes(bytes: Buffer): MediaType {
  if (bytes.length === 0) throw new MediaError(400, 'media_empty', 'the capture is empty');
  if (bytes.length > MEDIA_MAX_FILE_BYTES) {
    throw new MediaError(
      413,
      'media_too_large',
      `the capture is ${bytes.length} bytes; the limit is ${MEDIA_MAX_FILE_BYTES} (GitHub's attachment cap) — shorten the clip or lower its resolution`,
    );
  }
  const mediaType = sniffMediaType(bytes);
  if (mediaType === null) {
    throw new MediaError(
      415,
      'media_unsupported_type',
      'unsupported capture: send PNG, JPEG, GIF or WebP stills, or WebM/MP4 clips (convert QuickTime .mov to MP4, and HEIC/AVIF stills to PNG)',
    );
  }
  if (mediaKind(mediaType) === 'image') {
    try {
      assertDecodableImage(mediaType as Exclude<MediaType, 'video/webm' | 'video/mp4'>, bytes, 'the capture');
    } catch (error) {
      if (error instanceof ReviewEvidenceError) throw new MediaError(415, 'media_invalid', error.message);
      throw error;
    }
  }
  return mediaType;
}

/** A caption is one honest line: 1–200 characters, no control characters. */
export function validateCaption(value: unknown): string {
  if (typeof value !== 'string') throw new MediaError(400, 'bad_request', 'caption must be a string');
  const caption = value.trim();
  if (caption === '') throw new MediaError(400, 'bad_request', 'caption must say what the capture shows');
  if ([...caption].length > MEDIA_CAPTION_MAX_CHARS) {
    throw new MediaError(400, 'bad_request', `caption must be at most ${MEDIA_CAPTION_MAX_CHARS} characters`);
  }
  for (const character of caption) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029) {
      throw new MediaError(400, 'bad_request', 'caption must be a single line without control characters');
    }
    // Invisible and direction-changing characters can make a caption read
    // differently from what it says.
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) {
      throw new MediaError(400, 'bad_request', 'caption must not contain invisible or text-direction characters');
    }
  }
  return caption;
}

export function validateRole(value: unknown): MediaRole {
  if (value === undefined || value === null) return 'after';
  if (typeof value === 'string' && (MEDIA_ROLES as readonly string[]).includes(value)) return value as MediaRole;
  throw new MediaError(400, 'bad_request', `role must be one of ${MEDIA_ROLES.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A capture read back from its event; null when the payload does not parse
 * (a damaged row is never shown or published). */
export function readMediaItem(event: EventRecord): MediaItem | null {
  if (event.kind !== MEDIA_CAPTURED_EVENT || event.jobId === null || !isRecord(event.payload)) return null;
  const payload = event.payload;
  const id = payload['id'];
  const headSha = payload['head_sha'];
  const mediaType = payload['media_type'];
  const role = payload['role'];
  const caption = payload['caption'];
  const bytes = payload['bytes'];
  const sha256 = payload['sha256'];
  const file = payload['file'];
  const capturedBy = payload['captured_by'];
  const shot = readShot(payload['shot']);
  if (
    typeof id !== 'string' || !isMediaId(id) ||
    typeof headSha !== 'string' || !isFullSha(headSha) ||
    typeof mediaType !== 'string' || !(MEDIA_TYPES as readonly string[]).includes(mediaType) ||
    typeof role !== 'string' || !(MEDIA_ROLES as readonly string[]).includes(role) ||
    typeof caption !== 'string' || caption === '' ||
    typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 ||
    typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256) ||
    typeof file !== 'string' || file !== `${jobKey(event.jobId)}/${id}.${mediaExtension(mediaType as MediaType)}` ||
    // A GC capture always names its run and shot; a minion's never does.
    !(capturedBy === 'minion' ? payload['shot'] === undefined : capturedBy === 'gc' && shot !== null)
  ) {
    return null;
  }
  return {
    id,
    jobId: event.jobId,
    headSha,
    mediaType: mediaType as MediaType,
    kind: mediaKind(mediaType as MediaType),
    role: role as MediaRole,
    caption,
    bytes,
    sha256,
    file,
    capturedBy: capturedBy as MediaCapturedBy,
    shot: capturedBy === 'gc' ? shot : null,
    recordedAt: event.ts,
    seq: event.seq,
  };
}

function readShot(value: unknown): MediaShot | null {
  if (!isRecord(value)) return null;
  const runId = value['run_id'];
  const shotId = value['shot_id'];
  const viewport = value['viewport'];
  const files = value['files'];
  if (typeof runId !== 'string' || !CAPTURE_RUN_ID_RE.test(runId) ||
    typeof shotId !== 'string' || !SHOT_ID_RE.test(shotId) ||
    typeof viewport !== 'string' || !VIEWPORT_NAME_RE.test(viewport) ||
    typeof files !== 'number' || !Number.isInteger(files) || files < 1 || files > MEDIA_MAX_PER_HEAD) return null;
  return { runId, shotId, viewport, files };
}

/** The job's captures, oldest first (the newest 200 events). */
export function listMedia(ledger: Pick<MediaLedger, 'listJobEvents'>, jobId: string): readonly MediaItem[] {
  return ledger
    .listJobEvents(jobId, { kinds: [MEDIA_CAPTURED_EVENT], order: 'desc', limit: 200 })
    .map(readMediaItem)
    .filter((item): item is MediaItem => item !== null)
    .reverse();
}

/**
 * The CURRENT captures bound to exactly `headSha`, oldest first: every
 * minion capture at the head, and the GC captures of the newest COMPLETE
 * camera run at the head (every file it filmed is stored). A shot list
 * changed at the same head is filmed again; the new run replaces the older
 * run's files, which count as superseded. A run cut short never shows.
 */
export function mediaAtHead(items: readonly MediaItem[], headSha: string): readonly MediaItem[] {
  const atHead = items.filter((item) => item.headSha === headSha);
  const runs = new Map<string, { count: number; files: number; seq: number }>();
  for (const item of atHead) {
    if (item.shot === null) continue;
    const run = runs.get(item.shot.runId) ?? { count: 0, files: item.shot.files, seq: -1 };
    run.count += 1;
    run.seq = Math.max(run.seq, item.seq);
    runs.set(item.shot.runId, run);
  }
  let newestRun: string | null = null;
  let newestSeq = -1;
  for (const [runId, run] of runs) {
    if (run.count === run.files && run.seq > newestSeq) {
      newestSeq = run.seq;
      newestRun = runId;
    }
  }
  return atHead.filter((item) => item.shot === null || item.shot.runId === newestRun);
}

export function findMedia(ledger: Pick<MediaLedger, 'latestEventByPayloadField'>, id: string): MediaItem | null {
  if (!isMediaId(id)) return null;
  const event = ledger.latestEventByPayloadField(MEDIA_CAPTURED_EVENT, 'id', id);
  return event === null ? null : readMediaItem(event);
}

/** A private directory we own: created 0700, never a symlink. */
function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MediaError(500, 'media_store_unsafe', `media store path ${path} is not a plain directory`);
  }
}

export interface StoreMediaInput {
  readonly dataDir: string;
  readonly ledger: MediaLedger;
  readonly jobId: string;
  readonly headSha: string;
  readonly caption: string;
  readonly role: MediaRole;
  readonly bytes: Buffer;
  /** Absent = a minion's submission. GC's camera passes `gc` and the shot. */
  readonly capturedBy?: MediaCapturedBy;
  readonly shot?: MediaShot;
}

/** The current captures a new one at `headSha` would join: for a camera
 * run, the minion's captures plus the run's own earlier files (the run
 * replaces any older run at the head). */
function joinedAtHead(items: readonly MediaItem[], headSha: string, shot: MediaShot | undefined): readonly MediaItem[] {
  if (shot === undefined) return mediaAtHead(items, headSha);
  return items.filter((item) => item.headSha === headSha && (item.shot === null || item.shot.runId === shot.runId));
}

/** Validate, write once, and journal one capture. The caller has already
 * proved the lane sits at `headSha` with a clean tracked tree. */
export function storeMedia(input: StoreMediaInput): MediaItem {
  if (!isFullSha(input.headSha)) throw new MediaError(400, 'bad_request', 'head_sha must be the full 40-character commit sha');
  const capturedBy = input.capturedBy ?? 'minion';
  if ((capturedBy === 'gc') !== (input.shot !== undefined)) {
    throw new Error('storeMedia: a GC capture names its camera run and shot, and a minion capture names none');
  }
  if (input.shot !== undefined && readShot({ run_id: input.shot.runId, shot_id: input.shot.shotId, viewport: input.shot.viewport, files: input.shot.files }) === null) {
    throw new Error(`storeMedia: malformed camera shot identity ${JSON.stringify(input.shot)}`);
  }
  const caption = validateCaption(input.caption);
  const mediaType = validateMediaBytes(input.bytes);
  const atHead = joinedAtHead(listMedia(input.ledger, input.jobId), input.headSha, input.shot);
  if (atHead.length >= MEDIA_MAX_PER_HEAD) {
    throw new MediaError(
      409,
      'media_limit',
      `head ${input.headSha.slice(0, 12)} already has ${MEDIA_MAX_PER_HEAD} captures — the limit per head`,
    );
  }
  const root = mediaRoot(input.dataDir);
  ensurePrivateDir(root);
  const key = jobKey(input.jobId);
  ensurePrivateDir(join(root, key));
  const id = `m-${randomUUID()}`;
  const file = `${key}/${id}.${mediaExtension(mediaType)}`;
  writeFileSync(join(root, file), input.bytes, { flag: 'wx', mode: 0o600 });
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const event = input.ledger.appendCustomEvent({
    kind: MEDIA_CAPTURED_EVENT,
    jobId: input.jobId,
    payload: {
      id,
      head_sha: input.headSha,
      media_type: mediaType,
      role: input.role,
      caption,
      bytes: input.bytes.length,
      sha256,
      file,
      captured_by: capturedBy,
      ...(input.shot === undefined
        ? {}
        : { shot: { run_id: input.shot.runId, shot_id: input.shot.shotId, viewport: input.shot.viewport, files: input.shot.files } }),
    },
  });
  return {
    id,
    jobId: input.jobId,
    headSha: input.headSha,
    mediaType,
    kind: mediaKind(mediaType),
    role: input.role,
    caption,
    bytes: input.bytes.length,
    sha256,
    file,
    capturedBy,
    shot: input.shot ?? null,
    recordedAt: event.ts,
    seq: event.seq,
  };
}

/** Delete a closed job's local captures and journal it. Null when the job
 * has none on disk. The events stay: the record of what was captured is
 * kept, only the bytes go. */
export function sweepJobMedia(dataDir: string, ledger: Pick<MediaLedger, 'appendCustomEvent'>, jobId: string): { readonly files: number; readonly bytes: number } | null {
  const dir = join(mediaRoot(dataDir), jobKey(jobId));
  if (!existsSync(dir)) return null;
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MediaError(500, 'media_store_unsafe', `media store path ${dir} is not a plain directory`);
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += lstatSync(join(dir, entry.name)).size;
  }
  rmSync(dir, { recursive: true, force: true });
  ledger.appendCustomEvent({ kind: MEDIA_SWEPT_EVENT, jobId, payload: { files, bytes } });
  return { files, bytes };
}

/** The job keys that still hold captures on disk. */
export function storedMediaJobKeys(dataDir: string): ReadonlySet<string> {
  const root = mediaRoot(dataDir);
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

/** Read a capture's bytes, re-verifying size and hash. A missing or altered
 * file is refused — it is never served or published as the capture. */
export function readMediaBytes(dataDir: string, item: MediaItem): Buffer {
  const path = join(mediaRoot(dataDir), item.file);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new MediaError(410, 'media_missing', `capture ${item.id} is no longer in the media store (${code})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== item.bytes) {
      throw new MediaError(410, 'media_altered', `capture ${item.id} changed after it was recorded`);
    }
    const bytes = Buffer.alloc(item.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
      throw new MediaError(410, 'media_altered', `capture ${item.id} changed after it was recorded`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
