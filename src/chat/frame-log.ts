import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import {
  loggedFrameSeq,
  parseServerFrame,
  withSeq,
  type LoggedFrame,
  type UnseqedFrame,
} from './frames.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** The frame log on disk is corrupt — refuse to boot over it (fail-loud;
 * history is never silently truncated or reinterpreted). */
export class FrameLogCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`chat frame log ${file} is corrupt at line ${line}: ${detail}`);
    this.name = 'FrameLogCorruptError';
  }
}

export const FRAME_LOG_NAME = 'gru.frames.jsonl';

/** Default rotation policy: rotate at 8 MB, keep 3 shards (E4 replay-cost
 * deferral — bounded disk AND bounded replay, history intact in-window). */
export const FRAME_LOG_ROTATION_DEFAULTS = { maxBytes: 8_388_608, keep: 3 } as const;

/** Shard file for a slot (1 = most recent rotated). */
export function frameLogShardFile(dir: string, slot: number): string {
  return join(dir, `${FRAME_LOG_NAME}.${slot}`);
}

/**
 * Durable chat frame log (EPICS E4 story 3; SPEC ruling 3).
 *
 * The single source for reconnect replay: every seq-consuming frame the
 * chat server emits is appended here FIRST, keeping the counter equal to
 * the log's high-water mark at all times. Append-only jsonl under the
 * instance data dir (`<data_dir>/chat/`), loaded back at boot so history
 * and the seq counter survive service restarts.
 *
 * The mock's aborted-turn rule is mirrored at boot: if the loaded log
 * ends with an open turn (the process died mid-turn), closing frames are
 * appended before clients attach, so replays always see a settled
 * conversation.
 */
export class ChatFrameLog {
  readonly file: string;
  private frames: LoggedFrame[] = [];
  private seq = 0;
  /** Latest seq for each epoch + user-id pair. A client_msg_id may be
   * reused safely in a later durable chat epoch, but never within one. */
  private readonly seenUserIds = new Map<string, number>();
  /** Pre-upgrade user frames had no epoch. Their seq relative to the durable
   * replay floor assigns them to the one active epoch without rewriting logs. */
  private readonly legacySeenUserIds = new Map<string, number>();
  /** Open tool names (multiset stack) + whether a turn is open. */
  private readonly openTools: string[] = [];
  private turnOpen = false;
  private readonly rotation: { maxBytes: number; keep: number };
  /** Live-file byte count (rotation check without a statSync per append). */
  private liveBytes = 0;

  private constructor(dir: string, rotation: { maxBytes: number; keep: number }) {
    this.file = join(dir, FRAME_LOG_NAME);
    this.rotation = rotation;
  }

  /**
   * Load (or initialize) the log under `dir` and settle any open turn.
   * A torn FINAL line (crash mid-append) is dropped with a warn; any
   * other corruption fails loud. Seqs must be exactly 1..N consecutive
   * ACROSS shards + live — replay-end arithmetic depends on the counter
   * === high-water invariant. Shards load oldest→newest, then the live
   * file; rotation (E7) never breaks reconnect history within retention.
   */
  static load(
    dir: string,
    log: Log = () => {},
    rotation: { maxBytes?: number; keep?: number } = {},
  ): ChatFrameLog {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const policy = {
      maxBytes: rotation.maxBytes ?? FRAME_LOG_ROTATION_DEFAULTS.maxBytes,
      keep: rotation.keep ?? FRAME_LOG_ROTATION_DEFAULTS.keep,
    };
    const log_ = new ChatFrameLog(dir, policy);
    // Oldest shard first: slot numbers count DOWN toward 1 (newest). The
    // scan covers the configured keep (rotation never mints higher slots;
    // a keep-reduction prunes strays on the next rotation).
    const shardSlots: number[] = [];
    for (let slot = 1; slot <= policy.keep; slot++) {
      if (!existsSync(frameLogShardFile(dir, slot))) break;
      shardSlots.push(slot);
    }
    shardSlots.reverse(); // highest slot = oldest → load first
    for (const slot of shardSlots) {
      log_.loadFile(frameLogShardFile(dir, slot), log, slot === shardSlots[0]);
    }
    // The live file always continues the chain — a shard-less live file
    // starts at 1 (no pruning ever happened there).
    log_.loadFile(log_.file, log, false);
    const settled = log_.settleOpenTurn();
    if (settled.length > 0) {
      log('warn', 'chat frame log ended mid-turn — closing frames appended at boot', {
        file: log_.file,
        closing_frames: settled.length,
      });
    }
    return log_;
  }

  /** Load one file's lines into the in-memory history (seq continues
   * across files). Same fail-loud rules as before, scoped per file —
   * with ONE rotation-aware relaxation: the OLDEST shard may start at
   * any seq (retention pruned everything before it); every later file
   * must continue the chain exactly. A shard-less live file still must
   * start at seq 1 (nothing was ever pruned — a gap is corruption). */
  private loadFile(file: string, log: Log, isOldestShard: boolean): void {
    if (!existsSync(file)) {
      this.liveBytes = 0;
      return;
    }
    let text = readFileSync(file, 'utf-8');
    this.liveBytes = Buffer.byteLength(text, 'utf-8');
    // r2 B1'': a crash mid-append can cut the write between the final
    // frame's JSON and its terminator newline. A parseable final line
    // missing only the '\n' is torn-tail-class: keep the frame, repair
    // the terminator (atomically).
    if (text.length > 0 && !text.endsWith('\n')) {
      const tailStart = text.lastIndexOf('\n') + 1;
      const tail = text.slice(tailStart);
      const tailFrame = parseServerFrame(safeParse(tail));
      const repairable =
        tailFrame !== null &&
        tailFrame.type !== 'auth_ok' &&
        !(tailFrame.type === 'error' && tailFrame.fatal === true);
      if (repairable) {
        rewriteAtomically(file, `${text}\n`);
        log('warn', 'final frame line was missing its newline — terminator repaired (crash mid-append)', {
          file,
        });
        text = `${text}\n`;
        this.liveBytes = Buffer.byteLength(text, 'utf-8');
      }
      // else: the line loop below drops/raises as its content deserves.
    }
    const lines = text.split('\n');
    // A trailing newline produces a final empty entry — not a frame.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        if (index === lines.length - 1) {
          // Torn tail (crash mid-append): drop it AND repair the file —
          // leaving it on disk would bake it into mid-file corruption the
          // moment any later frame appends, and the NEXT boot would fail
          // loud over damage this boot could have healed.
          log('warn', 'dropping torn final line of chat frame log (crash mid-append)', {
            file,
            line: index + 1,
          });
          const validPrefix = lines.slice(0, index);
          rewriteAtomically(file, validPrefix.length > 0 ? `${validPrefix.join('\n')}\n` : '');
          break;
        }
        throw new FrameLogCorruptError(file, index + 1, `unparseable json (${String(error)})`);
      }
      const frame = parseServerFrame(parsed);
      if (
        frame === null ||
        frame.type === 'auth_ok' ||
        frame.type === 'context' ||
        frame.type === 'control_result' ||
        frame.type === 'context_event' ||
        // Keepalives are never persisted: a ping on disk is corrupt by
        // construction, not something to replay.
        frame.type === 'ping'
      ) {
        throw new FrameLogCorruptError(file, index + 1, 'not a logged chat frame');
      }
      if (frame.type === 'error' && frame.fatal === true) {
        // r2 W3': a persisted fatal frame is poison by construction (the
        // client treats any replayed fatal as pairing-fatal). The writer
        // cannot produce one (type-narrowed + append-guarded); a file
        // that carries one is corrupt — refuse, never replay it.
        throw new FrameLogCorruptError(
          file,
          index + 1,
          'a fatal error frame was persisted — fatal frames are never logged (client poison)',
        );
      }
      const seq = loggedFrameSeq(frame);
      if (this.frames.length === 0 && isOldestShard) {
        // Retention pruned everything before this shard: adopt the base.
        this.seq = seq - 1;
      }
      const expected = this.seq + 1;
      if (seq !== expected) {
        throw new FrameLogCorruptError(
          file,
          index + 1,
          `seq gap: expected ${expected}, found ${seq} (counter must equal the high-water mark)`,
        );
      }
      this.seq = seq;
      this.track(frame);
      this.frames.push(frame);
    }
  }

  get highWaterSeq(): number {
    return this.seq;
  }

  /** Whether the log currently ends inside an open turn. */
  get hasOpenTurn(): boolean {
    return this.turnOpen;
  }

  /** All logged frames (the replay source), in seq order. */
  get history(): readonly LoggedFrame[] {
    return this.frames;
  }

  hasSeenUserId(clientMsgId: string, epoch: number, replayFloorSeq = 0): boolean {
    return this.seenUserIds.has(userDedupKey(epoch, clientMsgId)) ||
      (this.legacySeenUserIds.get(clientMsgId) ?? 0) > replayFloorSeq;
  }

  /**
   * Append a frame: assigns the next seq, persists the line, tracks
   * turn/tool openness and user-id dedup. The ONLY way frames enter the
   * log — the seq counter never diverges from the high-water mark.
   */
  append(frame: UnseqedFrame): LoggedFrame {
    const next = this.seq + 1;
    const seqed = withSeq(frame, next);
    // r2 B2'': anything appendable must survive load() — validate BEFORE
    // writing (and before advancing the counter): an invalid runtime
    // string (empty message/tool name) or a smuggled fatal flag would
    // otherwise brick the NEXT boot. Persist before advancing (r1 N11):
    // a failed write (ENOSPC/EACCES) must not leave a counter/file gap.
    const check = parseServerFrame(seqed);
    if (check === null || (check.type === 'error' && check.fatal === true)) {
      throw new Error(
        `refusing to persist a frame load() would reject: ${JSON.stringify(frame)}`,
      );
    }
    const line = `${JSON.stringify(seqed)}\n`;
    this.rotateIfNeeded(Buffer.byteLength(line, 'utf-8'));
    appendFileSync(this.file, line, 'utf-8');
    this.liveBytes += Buffer.byteLength(line, 'utf-8');
    this.seq = next;
    this.track(seqed);
    this.frames.push(seqed);
    return seqed;
  }

  /**
   * Size-based rotation (E7): shift shards up (pruning past keep),
   * rename the live file to shard 1, and let the append start a fresh
   * live file. In-memory history (the replay source) is untouched —
   * reconnect history stays intact within the retention window.
   */
  private rotateIfNeeded(incomingBytes: number): void {
    if (this.liveBytes + incomingBytes <= this.rotation.maxBytes) return;
    const dir = join(this.file, '..');
    // Prune EVERYTHING at/past keep first (a keep-reduction must not
    // leave strays), then shift the surviving slots up one.
    for (let slot = this.rotation.keep; slot <= this.rotation.keep + 99; slot++) {
      try {
        rmSync(frameLogShardFile(dir, slot), { force: true });
      } catch {
        /* best effort */
      }
    }
    for (let slot = this.rotation.keep - 1; slot >= 1; slot--) {
      try {
        renameSync(frameLogShardFile(dir, slot), frameLogShardFile(dir, slot + 1));
      } catch {
        /* best effort */
      }
    }
    try {
      renameSync(this.file, frameLogShardFile(dir, 1));
    } catch {
      /* best effort — the append still lands in the live file */
    }
    this.liveBytes = 0;
  }

  /** Frames with seq > lastSeenSeq, in order (the reconnect replay). */
  replayAfter(lastSeenSeq: number, replayFloorSeq = 0): readonly LoggedFrame[] {
    const floor = Math.max(lastSeenSeq, replayFloorSeq);
    return this.frames.filter((frame) => loggedFrameSeq(frame) > floor);
  }

  /**
   * Close an open turn left by a dead process (the mock's aborted-turn
   * rule at boot): open tools end in reverse order, then the turn ends.
   * No-op on a settled log. Returns the closing frames appended.
   */
  settleOpenTurn(): LoggedFrame[] {
    const closing: LoggedFrame[] = [];
    while (this.openTools.length > 0) {
      const name = this.openTools[this.openTools.length - 1]!;
      closing.push(this.append({ type: 'tool', name, state: 'end' }));
    }
    if (this.turnOpen) {
      closing.push(this.append({ type: 'turn', state: 'end' }));
    }
    return closing;
  }

  private track(frame: LoggedFrame): void {
    switch (frame.type) {
      case 'user':
        if (frame.epoch !== undefined) {
          this.seenUserIds.set(userDedupKey(frame.epoch, frame.client_msg_id), frame.seq);
        } else {
          this.legacySeenUserIds.set(frame.client_msg_id, frame.seq);
        }
        break;
      case 'tool':
        if (frame.state === 'start') {
          this.openTools.push(frame.name);
        } else {
          const index = this.openTools.lastIndexOf(frame.name);
          if (index >= 0) this.openTools.splice(index, 1);
        }
        break;
      case 'turn':
        this.turnOpen = frame.state === 'start';
        break;
      default:
        break;
    }
  }
}

function userDedupKey(epoch: number, clientMsgId: string): string {
  return `${epoch}\u0000${clientMsgId}`;
}

/** JSON.parse that yields null instead of throwing (tail probing). */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Rewrite the whole file via tmp + rename: a repair that crashes midway
 * must never leave a half-written log behind (r2 note). */
function rewriteAtomically(file: string, contents: string): void {
  const staging = `${file}.repair-${process.pid}`;
  writeFileSync(staging, contents, 'utf-8');
  renameSync(staging, file);
}
