import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ChatFrameLog,
  FRAME_LOG_NAME,
  FrameLogCorruptError,
} from '../src/chat/frame-log.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-chatlog-'));
  cleanupDirs.push(dir);
  return dir;
}

function seedFile(dir: string, frames: readonly unknown[]): void {
  writeFileSync(
    join(dir, FRAME_LOG_NAME),
    frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
    'utf-8',
  );
}

describe('ChatFrameLog', () => {
  it('loads empty on a missing file and assigns seqs from 1', () => {
    const log = ChatFrameLog.load(fixture());
    expect(log.highWaterSeq).toBe(0);
    expect(log.history).toEqual([]);
    const first = log.append({ type: 'turn', state: 'start' });
    expect(first).toEqual({ type: 'turn', state: 'start', seq: 1 });
    expect(log.highWaterSeq).toBe(1);
  });

  it('persists every append and reloads with the counter at the high-water mark', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'user', text: 'hello', client_msg_id: 'id-1', epoch: 0 });
    log.append({ type: 'ack', client_msg_id: 'id-1' });
    log.append({ type: 'delta', text: 'chunk' });

    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.highWaterSeq).toBe(3);
    expect(reloaded.history).toEqual([
      { type: 'user', text: 'hello', client_msg_id: 'id-1', epoch: 0, seq: 1 },
      { type: 'ack', client_msg_id: 'id-1', seq: 2 },
      { type: 'delta', text: 'chunk', seq: 3 },
    ]);
    // The counter continues where the previous process left off.
    const next = reloaded.append({ type: 'turn', state: 'end' });
    expect(next).toEqual({ type: 'turn', state: 'end', seq: 4 });
  });

  it('replayAfter returns exactly the frames above the watermark in order', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'user', text: 'a', client_msg_id: 'id-1', seq: 1 },
      { type: 'ack', client_msg_id: 'id-1', seq: 2 },
      { type: 'delta', text: 'x', seq: 3 },
      { type: 'turn', state: 'end', seq: 4 },
    ]);
    const log = ChatFrameLog.load(dir);
    expect(log.replayAfter(0)).toHaveLength(4);
    expect(log.replayAfter(2)).toEqual([
      { type: 'delta', text: 'x', seq: 3 },
      { type: 'turn', state: 'end', seq: 4 },
    ]);
    expect(log.replayAfter(4)).toEqual([]);
    expect(log.replayAfter(99)).toEqual([]);
  });

  it('applies an epoch replay floor without modifying historical frames or cross-epoch dedup', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'user', text: 'old', client_msg_id: 'same-id', epoch: 0 });
    log.append({ type: 'delta', text: 'old reply' });
    const bytesBefore = readFileSync(join(dir, FRAME_LOG_NAME), 'utf-8');
    expect(log.replayAfter(0, 2)).toEqual([]);
    expect(log.hasSeenUserId('same-id', 0)).toBe(true);
    expect(log.hasSeenUserId('same-id', 1)).toBe(false);
    log.append({ type: 'user', text: 'new', client_msg_id: 'same-id', epoch: 1 });
    expect(log.hasSeenUserId('same-id', 1)).toBe(true);
    expect(readFileSync(join(dir, FRAME_LOG_NAME), 'utf-8').startsWith(bytesBefore)).toBe(true);
  });

  it('scopes legacy unstamped dedup by the durable replay floor', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    const legacy = log.append({ type: 'user', text: 'legacy', client_msg_id: 'legacy-id' });
    expect(log.hasSeenUserId('legacy-id', 0, 0)).toBe(true);
    expect(log.hasSeenUserId('legacy-id', 1, legacy.seq)).toBe(false);
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.hasSeenUserId('legacy-id', 0, 0)).toBe(true);
    expect(reloaded.hasSeenUserId('legacy-id', 1, legacy.seq)).toBe(false);
  });

  it('rebuilds the client_msg_id dedup index across reloads', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'user', text: 'once', client_msg_id: 'id-7', epoch: 4 });
    expect(log.hasSeenUserId('id-7', 4)).toBe(true);
    expect(log.hasSeenUserId('id-8', 4)).toBe(false);
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.hasSeenUserId('id-7', 4)).toBe(true);
  });

  it('tolerates a torn final line (crash mid-append) with a warn', () => {
    const dir = fixture();
    const warnings: string[] = [];
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\n{"type":"delta","te',
      'utf-8',
    );
    const log = ChatFrameLog.load(dir, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    // The valid prefix survived; the torn tail was dropped.
    expect(log.history[0]).toEqual({ type: 'turn', state: 'start', seq: 1 });
    expect(warnings.some((msg) => msg.includes('torn final line'))).toBe(true);
    // The settled log (turn was open) appends closing frames with fresh seqs.
    expect(log.highWaterSeq).toBe(2);
    expect(log.history[1]).toEqual({ type: 'turn', state: 'end', seq: 2 });
  });

  it('repairs a torn tail on load: boot-settle appends and the next load stays green', () => {
    const dir = fixture();
    // The verdict's repro shape: crash mid-append leaves a torn tail OVER
    // an open turn — boot 1 must repair the file AND append ≥2 closing
    // frames (boot-settle), and boot 2 must load clean.
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"user","text":"go","client_msg_id":"id-1","seq":1}\n' +
        '{"type":"ack","client_msg_id":"id-1","seq":2}\n' +
        '{"type":"turn","state":"start","seq":3}\n' +
        '{"type":"tool","name":"bash","state":"start","seq":4}\n' +
        '{"type":"delta","te',
      'utf-8',
    );
    const log = ChatFrameLog.load(dir);
    // The valid prefix (4 frames) survived; boot-settle appended the two
    // closing frames AFTER the on-disk repair — high-water is already 6.
    expect(log.highWaterSeq).toBe(6);
    expect(log.history.slice(4)).toEqual([
      { type: 'tool', name: 'bash', state: 'end', seq: 5 },
      { type: 'turn', state: 'end', seq: 6 },
    ]);
    // Post-crash traffic appends normally — and the NEXT boot is green.
    log.append({ type: 'delta', text: 'after the crash' });
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.history).toEqual([
      { type: 'user', text: 'go', client_msg_id: 'id-1', seq: 1 },
      { type: 'ack', client_msg_id: 'id-1', seq: 2 },
      { type: 'turn', state: 'start', seq: 3 },
      { type: 'tool', name: 'bash', state: 'start', seq: 4 },
      { type: 'tool', name: 'bash', state: 'end', seq: 5 },
      { type: 'turn', state: 'end', seq: 6 },
      { type: 'delta', text: 'after the crash', seq: 7 },
    ]);
  });

  it('a newline-less parseable final line is repaired, not merged: load→append→load', () => {
    const dir = fixture();
    // r2 B1'': crash cut the write between the JSON and its '\n'.
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\n' +
        '{"type":"turn","state":"end","seq":2}',
      'utf-8',
    );
    const log = ChatFrameLog.load(dir);
    expect(log.highWaterSeq).toBe(2); // the frame survived, terminator repaired
    // The next append lands on its OWN line — reload keeps all frames.
    log.append({ type: 'delta', text: 'after repair' });
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.history).toEqual([
      { type: 'turn', state: 'start', seq: 1 },
      { type: 'turn', state: 'end', seq: 2 },
      { type: 'delta', text: 'after repair', seq: 3 },
    ]);
  });

  it('append() refuses frames load() would reject: empty strings and fatal flags', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'delta', text: 'seed' });
    const before = log.highWaterSeq;
    // Empty runtime strings are unpersistable (load rejects them).
    expect(() => log.append({ type: 'error', message: '' })).toThrowError(/refusing to persist/);
    // A smuggled fatal flag is unpersistable (client poison).
    expect(() =>
      log.append({ type: 'error', message: 'poison', fatal: true } as never),
    ).toThrowError(/refusing to persist/);
    // Counter + file unchanged — the next append continues without a gap
    // (closed pair, so the reload's boot-settle stays out of the count).
    expect(log.highWaterSeq).toBe(before);
    const next = log.append({ type: 'turn', state: 'start' });
    expect(next).toMatchObject({ seq: before + 1 });
    log.append({ type: 'turn', state: 'end' });
    expect(ChatFrameLog.load(dir).highWaterSeq).toBe(before + 2);
  });

  it('a persisted fatal line is corruption: load refuses it loud', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'turn', state: 'start', seq: 1 },
      { type: 'error', message: 'poison', fatal: true, seq: 2 },
    ]);
    expect(() => ChatFrameLog.load(dir)).toThrowError(/fatal error frame was persisted/);
  });

  it('a failed write advances neither the counter nor the file (no seq gap)', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'delta', text: 'one' });
    const file = join(dir, FRAME_LOG_NAME);
    chmodSync(file, 0o444); // append now fails EACCES
    expect(() => log.append({ type: 'delta', text: 'lost' })).toThrowError();
    expect(log.highWaterSeq).toBe(1); // counter did NOT advance
    chmodSync(file, 0o644);
    const next = log.append({ type: 'delta', text: 'two' });
    expect(next).toMatchObject({ seq: 2 }); // no gap
    expect(ChatFrameLog.load(dir).highWaterSeq).toBe(2); // reload clean
  });

  it('fails loud on mid-file corruption (never silently truncates history)', () => {
    const dir = fixture();
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\nGARBAGE\n{"type":"turn","state":"end","seq":3}\n',
      'utf-8',
    );
    expect(() => ChatFrameLog.load(dir)).toThrowError(FrameLogCorruptError);
    try {
      ChatFrameLog.load(dir);
    } catch (error) {
      expect((error as FrameLogCorruptError).line).toBe(2);
    }
  });

  it('fails loud on a seq gap (the counter must equal the high-water mark)', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'turn', state: 'start', seq: 1 },
      { type: 'turn', state: 'end', seq: 7 },
    ]);
    expect(() => ChatFrameLog.load(dir)).toThrowError(/seq gap/);
  });

  it('fails loud on every ephemeral frame type persisted in the durable log', () => {
    const ephemeralFrames = [
      { type: 'auth_ok', seq: 1 },
      {
        type: 'context',
        epoch: 0,
        replay_floor_seq: 0,
        state: 'idle',
        usage: null,
        compact_supported: false,
        session_active: false,
        writer: true,
        seq: 1,
      },
      {
        type: 'control_result',
        action: 'compact',
        request_id: 'compact-1',
        ok: true,
        epoch: 0,
        seq: 1,
      },
      { type: 'context_event', action: 'compact', ok: true, seq: 1 },
    ];
    for (const frame of ephemeralFrames) {
      const dir = fixture();
      seedFile(dir, [frame]);
      expect(() => ChatFrameLog.load(dir)).toThrowError(/not a logged chat frame/);
    }
  });

  it('boot-settles an open turn: open tools end in reverse order, then the turn', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'user', text: 'go', client_msg_id: 'id-1', seq: 1 },
      { type: 'turn', state: 'start', seq: 2 },
      { type: 'tool', name: 'bash', state: 'start', seq: 3 },
      { type: 'tool', name: 'read', state: 'start', seq: 4 },
      { type: 'tool', name: 'read', state: 'end', seq: 5 },
      { type: 'tool', name: 'edit', state: 'start', seq: 6 },
    ]);
    const warnings: string[] = [];
    const log = ChatFrameLog.load(dir, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    // edit ends, then bash ends, then the turn — and only those.
    expect(log.history.slice(6)).toEqual([
      { type: 'tool', name: 'edit', state: 'end', seq: 7 },
      { type: 'tool', name: 'bash', state: 'end', seq: 8 },
      { type: 'turn', state: 'end', seq: 9 },
    ]);
    expect(warnings.some((msg) => msg.includes('mid-turn'))).toBe(true);
    // A second load finds a settled log — no further additions.
    const again = ChatFrameLog.load(dir);
    expect(again.highWaterSeq).toBe(9);
    expect(again.hasOpenTurn).toBe(false);
  });

  it('tracks hasOpenTurn across the turn lifecycle', () => {
    const log = ChatFrameLog.load(fixture());
    expect(log.hasOpenTurn).toBe(false);
    log.append({ type: 'turn', state: 'start' });
    expect(log.hasOpenTurn).toBe(true);
    log.append({ type: 'turn', state: 'end' });
    expect(log.hasOpenTurn).toBe(false);
  });

  it('persists one json object per line (append-only on disk)', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'delta', text: 'a' });
    log.append({ type: 'delta', text: 'b' });
    const lines = readFileSync(join(dir, FRAME_LOG_NAME), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'delta', text: 'a', seq: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'delta', text: 'b', seq: 2 });
  });
});

describe('ChatFrameLog rotation (E7)', () => {
  it('rotates at the cap: replay spans shards, seqs stay consecutive, retention prunes', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir, () => {}, { maxBytes: 300, keep: 2 });
    // Each delta frame is ~50 bytes on disk; push well past 3 rotations.
    for (let i = 0; i < 30; i += 1) {
      log.append({ type: 'delta', text: `beat-${i}-${'y'.repeat(8)}` });
    }
    // Shards 1..2 exist; the live file is fresh (small).
    const shards = readdirSync(dir).filter((n) => /^gru\.frames\.jsonl\.\d+$/.test(n)).sort();
    expect(shards.length).toBe(2);
    expect(existsSync(join(dir, FRAME_LOG_NAME))).toBe(true);

    // Reload: history spans shards oldest→newest→live, consecutive WITHIN
    // the retained window (retention legitimately pruned the oldest).
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.highWaterSeq).toBe(30);
    const seqs = reloaded.history.map((f) => (f.type === 'delta' ? f.seq : 0));
    const firstSeq = seqs[0] ?? 0;
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => firstSeq + i));
    // Pruning is real: the retained window starts past seq 1.
    expect(firstSeq).toBeGreaterThan(1);
    // Replay from zero returns the full RETAINED history.
    expect(reloaded.replayAfter(0).length).toBe(seqs.length);
    // Appends continue the counter across the shard boundary.
    const next = reloaded.append({ type: 'delta', text: 'post-rotation' });
    expect(next.seq).toBe(31);
  });

  it('a rotation shard ending mid-turn is settled by the LIVE file continuation (no false close)', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir, () => {}, { maxBytes: 220, keep: 1 });
    log.append({ type: 'turn', state: 'start' });
    for (let i = 0; i < 12; i += 1) {
      log.append({ type: 'delta', text: `spin-${i}-xxxxxxxx` }); // forces rotation mid-turn
    }
    log.append({ type: 'turn', state: 'end' });
    // Reload mid-shards: the turn-open state is tracked ACROSS files, so
    // boot-settle must NOT append a bogus turn end.
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.hasOpenTurn).toBe(false);
    expect(reloaded.history.at(-1)).toEqual({ type: 'turn', state: 'end', seq: reloaded.highWaterSeq });
    expect(reloaded.history.filter((f) => f.type === 'turn' && f.state === 'end').length).toBe(1);
  });
});
