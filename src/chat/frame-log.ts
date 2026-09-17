import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  private readonly log: Log;
  private frames: LoggedFrame[] = [];
  private seq = 0;
  /** client_msg_ids of every logged `user` frame (dedup on re-send). */
  private readonly seenUserIds = new Set<string>();
  /** Open tool names (multiset stack) + whether a turn is open. */
  private readonly openTools: string[] = [];
  private turnOpen = false;

  private constructor(dir: string, log: Log) {
    this.file = join(dir, FRAME_LOG_NAME);
    this.log = log;
  }

  /**
   * Load (or initialize) the log under `dir` and settle any open turn.
   * A torn FINAL line (crash mid-append) is dropped with a warn; any
   * other corruption fails loud. Seqs must be exactly 1..N consecutive —
   * replay-end arithmetic depends on the counter === high-water invariant.
   */
  static load(dir: string, log: Log = () => {}): ChatFrameLog {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log_ = new ChatFrameLog(dir, log);
    if (!existsSync(log_.file)) return log_;
    const text = readFileSync(log_.file, 'utf-8');
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
          log('warn', 'dropping torn final line of chat frame log (crash mid-append)', {
            file: log_.file,
            line: index + 1,
          });
          break;
        }
        throw new FrameLogCorruptError(log_.file, index + 1, `unparseable json (${String(error)})`);
      }
      const frame = parseServerFrame(parsed);
      if (frame === null || frame.type === 'auth_ok') {
        throw new FrameLogCorruptError(log_.file, index + 1, 'not a logged chat frame');
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
    this.seq += 1;
    const seqed = withSeq(frame, this.seq);
    appendFileSync(this.file, `${JSON.stringify(seqed)}\n`, 'utf-8');
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
