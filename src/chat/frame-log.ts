import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  /** client_msg_ids of every logged `user` frame (dedup on re-send). */
  private readonly seenUserIds = new Set<string>();
  /** Open tool names (multiset stack) + whether a turn is open. */
  private readonly openTools: string[] = [];
  private turnOpen = false;

  private constructor(dir: string) {
    this.file = join(dir, FRAME_LOG_NAME);
  }

  /**
   * Load (or initialize) the log under `dir` and settle any open turn.
   * A torn FINAL line (crash mid-append) is dropped with a warn; any
   * other corruption fails loud. Seqs must be exactly 1..N consecutive —
   * replay-end arithmetic depends on the counter === high-water invariant.
   */
  static load(dir: string, log: Log = () => {}): ChatFrameLog {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log_ = new ChatFrameLog(dir);
    if (!existsSync(log_.file)) return log_;
    let text = readFileSync(log_.file, 'utf-8');
    // r2 B1'': a crash mid-append can cut the write between the final
    // frame's JSON and its terminator newline. That line LOADS fine — but
    // the next append merges onto it (reboot drops both frames and
    // resets the counter, or the merge lands mid-file and bricks boot).
    // A parseable final line missing only the '\n' is torn-tail-class:
    // keep the frame, repair the terminator (atomically).
    if (text.length > 0 && !text.endsWith('\n')) {
      const tailStart = text.lastIndexOf('\n') + 1;
      const tail = text.slice(tailStart);
      const tailFrame = parseServerFrame(safeParse(tail));
      const repairable =
        tailFrame !== null &&
        tailFrame.type !== 'auth_ok' &&
        !(tailFrame.type === 'error' && tailFrame.fatal === true);
      if (repairable) {
        rewriteAtomically(log_.file, `${text}\n`);
        log('warn', 'final frame line was missing its newline — terminator repaired (crash mid-append)', {
          file: log_.file,
        });
        text = `${text}\n`;
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
            file: log_.file,
            line: index + 1,
          });
          const validPrefix = lines.slice(0, index);
          rewriteAtomically(
            log_.file,
            validPrefix.length > 0 ? `${validPrefix.join('\n')}\n` : '',
          );
          break;
        }
        throw new FrameLogCorruptError(log_.file, index + 1, `unparseable json (${String(error)})`);
      }
      const frame = parseServerFrame(parsed);
      if (frame === null || frame.type === 'auth_ok') {
        throw new FrameLogCorruptError(log_.file, index + 1, 'not a logged chat frame');
      }
      if (frame.type === 'error' && frame.fatal === true) {
        // r2 W3': a persisted fatal frame is poison by construction (the
        // client treats any replayed fatal as pairing-fatal). The writer
        // cannot produce one (type-narrowed + append-guarded); a file
        // that carries one is corrupt — refuse, never replay it.
        throw new FrameLogCorruptError(
          log_.file,
          index + 1,
          'a fatal error frame was persisted — fatal frames are never logged (client poison)',
        );
      }
      const seq = loggedFrameSeq(frame);
      if (seq !== index + 1) {
        throw new FrameLogCorruptError(
          log_.file,
          index + 1,
          `seq gap: expected ${index + 1}, found ${seq} (counter must equal the high-water mark)`,
        );
      }
      log_.track(frame);
      log_.frames.push(frame);
    }
    log_.seq = log_.frames.length;
    const settled = log_.settleOpenTurn();
    if (settled.length > 0) {
      log('warn', 'chat frame log ended mid-turn — closing frames appended at boot', {
        file: log_.file,
        closing_frames: settled.length,
      });
    }
    return log_;
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

  hasSeenUserId(clientMsgId: string): boolean {
    return this.seenUserIds.has(clientMsgId);
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
    appendFileSync(this.file, `${JSON.stringify(seqed)}\n`, 'utf-8');
    this.seq = next;
    this.track(seqed);
    this.frames.push(seqed);
    return seqed;
  }

  /** Frames with seq > lastSeenSeq, in order (the reconnect replay). */
  replayAfter(lastSeenSeq: number): readonly LoggedFrame[] {
    return this.frames.filter((frame) => loggedFrameSeq(frame) > lastSeenSeq);
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
        this.seenUserIds.add(frame.client_msg_id);
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
