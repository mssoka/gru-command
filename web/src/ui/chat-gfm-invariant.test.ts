// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatView } from './chat.js';
import type { LoggedFrame, TurnFrame } from '../lib/protocol.js';

/**
 * THE RAW-MARKDOWN INVARIANT GATE (issue #10, USER CANON — hard v1 gate).
 *
 * "A test renders a Gru reply containing a table + code block and FAILS
 *  if raw pipes/fences reach the DOM."
 *
 * This runs the EXACT production path: `ChatView.addFrame` fed the same
 * `turn`/`delta` frames the socket delivers — live streaming and replay
 * both go through it. MUTATION PROOF (run when touching the renderer):
 * disable markdown rendering (make the delta path append raw text nodes
 * again, i.e. revert chat.ts's delta case to
 * `bubble.appendChild(document.createTextNode(frame.text))`) — this suite
 * must go RED. If it stays green, the gate is vacuous: fix the gate.
 */

/** A Gru reply shaped like real orchestrator traffic: table + code block. */
const REPLY = [
  'Here is the status, boss 🚀',
  '',
  '| Lane | State | Owner |',
  '|---|:---:|---:|',
  '| engine | ✅ done | minion-1 |',
  '| art | 🎨 working | minion-2 |',
  '',
  'Verify with:',
  '',
  '```bash',
  'npm test',
  '```',
  '',
  'All **green**, all *stable*.',
].join('\n');

let seq = 0;
const turn = (state: TurnFrame['state']): LoggedFrame => ({ type: 'turn', state, seq: (seq += 1) });
const delta = (text: string): LoggedFrame => ({ type: 'delta', text, seq: (seq += 1) });

function allText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    parts.push(n.textContent ?? '');
  }
  return parts.join('');
}

beforeEach(() => {
  seq = 0;
  document.body.replaceChildren();
  // Minimal ChatView skeleton (mirrors web/index.html ids), built with
  // DOM APIs — the codebase never touches innerHTML, tests included.
  const mainMount = document.createElement('div');
  mainMount.id = 'chat-main-mount';
  const log = document.createElement('div');
  log.id = 'chat-log';
  const form = document.createElement('form');
  form.id = 'chat-form';
  const input = document.createElement('input');
  input.id = 'chat-input';
  const send = document.createElement('button');
  send.id = 'chat-send';
  form.append(input, send);
  const view = document.createElement('section');
  view.id = 'chat-view';
  view.append(log, form);
  const bubble = document.createElement('button');
  bubble.id = 'chat-bubble';
  const badge = document.createElement('span');
  badge.id = 'chat-badge';
  badge.textContent = '0';
  bubble.append(badge);
  const sheet = document.createElement('div');
  sheet.id = 'chat-sheet';
  const grip = document.createElement('div');
  grip.id = 'chat-sheet-grip';
  const sheetMount = document.createElement('div');
  sheetMount.id = 'chat-sheet-mount';
  sheet.append(grip, sheetMount);
  document.body.append(mainMount, view, bubble, sheet);
  // Desktop placement (matchMedia stub: never matches the mobile query).
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

describe('raw-markdown invariant gate (issue #10)', () => {
  it('a streamed Gru reply renders table + code block with NO raw pipes/fences in the DOM', () => {
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), true);
    // Stream in awkward chunks — boundaries land mid-construct on purpose.
    for (let i = 0; i < REPLY.length; i += 7) {
      view.addFrame(delta(REPLY.slice(i, i + 7)), true);
    }

    const log = document.getElementById('chat-log');
    expect(log).not.toBeNull();
    let text = allText(log as HTMLElement);

    // INVARIANT ALREADY HOLDS BEFORE TURN END: the streaming renders
    // themselves must never show raw pipes/fences (mutation-sensitive —
    // a disabled delta-path renderer fails HERE, not just mid-stream).
    expect(text, 'pre-turn-end: no raw table pipes').not.toContain('|');
    expect(text, 'pre-turn-end: no raw code fences').not.toContain('```');
    expect((log as HTMLElement).querySelector('table.md-table'), 'table rendered mid-stream').not.toBeNull();
    expect((log as HTMLElement).querySelector('pre.md-code'), 'code rendered mid-stream').not.toBeNull();

    view.addFrame(turn('end'), true);
    text = allText(log as HTMLElement);

    // Structure exists: GFM table + fenced code rendered as elements.
    const table = log?.querySelector('.msg--gru table.md-table');
    expect(table, 'GFM table must render as a <table>').not.toBeNull();
    const ths = [...(table?.querySelectorAll<HTMLElement>('thead th') ?? [])];
    expect(ths.map((th) => th.textContent)).toEqual(['Lane', 'State', 'Owner']);
    expect(ths[1]?.style.textAlign).toBe('center');
    expect(ths[2]?.style.textAlign).toBe('right');
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table?.querySelector('tbody td')?.textContent).toBe('engine');

    const code = log?.querySelector('.msg--gru pre.md-code code');
    expect(code, 'code fence must render as a <pre><code>').not.toBeNull();
    expect(code?.textContent).toBe('npm test');
    expect(log?.querySelector('.md-code__lang')?.textContent).toBe('bash');
    expect(log?.querySelector('.msg--gru strong')?.textContent).toBe('green');
    expect(log?.querySelector('.msg--gru em')?.textContent).toBe('stable');

    // THE INVARIANT: raw pipes and fences never reach the DOM.
    expect(text, 'no raw table pipes anywhere in the log').not.toContain('|');
    expect(text, 'no raw code fences anywhere in the log').not.toContain('```');
    expect(text, 'no raw separator rows').not.toContain('---|');
    expect(text).toContain('Here is the status, boss 🚀');
  });

  it('the invariant holds at EVERY streaming prefix (no mid-stream flicker of raw markdown)', () => {
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), true);
    for (let i = 0; i < REPLY.length; i += 3) {
      view.addFrame(delta(REPLY.slice(i, i + 3)), true);
      const text = allText(document.getElementById('chat-log') as HTMLElement);
      expect(text, `mid-stream at offset ${i}: no raw pipes`).not.toContain('|');
      expect(text, `mid-stream at offset ${i}: no raw fences`).not.toContain('```');
    }
    view.addFrame(turn('end'), true);
  });

  it('replayed history (fresh page load) renders the reply, not raw markdown', () => {
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), false);
    view.addFrame(delta(REPLY), false);
    view.addFrame(turn('end'), false);
    const log = document.getElementById('chat-log') as HTMLElement;
    expect(log.querySelector('table.md-table')).not.toBeNull();
    expect(log.querySelector('pre.md-code')).not.toBeNull();
    expect(allText(log)).not.toContain('|');
    expect(allText(log)).not.toContain('```');
  });

  it('user messages stay PLAIN TEXT even when they contain markdown', () => {
    const view = new ChatView(() => {});
    view.reset();
    view.upsertMessage({
      client_msg_id: 'u1',
      text: '| not | a table |\n\n```not code```',
      status: 'acked',
    });
    const log = document.getElementById('chat-log') as HTMLElement;
    const user = log.querySelector('.msg--user');
    expect(user).not.toBeNull();
    expect(user?.textContent).toContain('| not | a table |');
    expect(user?.textContent).toContain('```not code```');
    // Plain text means plain: no markdown structure was created.
    expect(log.querySelector('table')).toBeNull();
    expect(log.querySelector('pre')).toBeNull();
    expect(log.querySelector('.msg__body')).toBeNull();
  });

  it('a mid-turn socket drop marks the stream incomplete with no raw pipes/fences; recovery replays clean', () => {
    // Perkins r1 warning 7 (misnumbered "blocker" in the r1 fix commit —
    // r1's blocker was the reconnect text loss, fixed separately below):
    // markStreamIncomplete (the ruling-3 surface — a dropped socket
    // mid-turn must never expose raw markdown, and the connection-lost
    // state must be legible). The recovery leg here models the
    // FRESH-PAGE-LOAD path (last_seen_seq=0 → replayStart(true) →
    // reset() + full frame re-delivery, turn:start included). The
    // SAME-PAGE reconnect path (partial replay, bare deltas) is pinned
    // separately in the reconnect test below.
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), true);
    // Stream the reply plus a partial fence marker still growing when the
    // socket drops: ...stable.\n``  — the `` is held mid-stream.
    const dropped = REPLY + '\n' + '``';
    for (let i = 0; i < dropped.length; i += 7) {
      view.addFrame(delta(dropped.slice(i, i + 7)), true);
    }
    const log = document.getElementById('chat-log') as HTMLElement;
    let text = allText(log);
    expect(text, 'pre-drop: no raw pipes').not.toContain('|');
    expect(text, 'pre-drop: no raw fences').not.toContain('```');
    expect(text, 'pre-drop: partial marker held').not.toContain('``');

    view.markStreamIncomplete();

    const gru = log.querySelector('.msg--gru') as HTMLElement;
    expect(gru.classList.contains('msg--streaming')).toBe(false);
    expect(gru.querySelector('.msg__meta')?.textContent).toMatch(/connection lost/i);
    text = allText(log);
    expect(text, 'at drop: no raw pipes').not.toContain('|');
    expect(text, 'at drop: no raw fences').not.toContain('```');
    expect(text, 'at drop: the text-so-far is final — held fragment materializes as literal text')
      .toContain('``');
    expect(gru.querySelector('table.md-table'), 'table intact at drop').not.toBeNull();
    expect(gru.querySelector('pre.md-code'), 'code block intact at drop').not.toBeNull();

    // Recovery — FRESH PAGE LOAD: full replay (last_seen_seq=0) calls
    // reset() then re-delivers every frame, turn:start included.
    view.reset();
    view.addFrame(turn('start'), false);
    view.addFrame(delta(REPLY), false);
    view.addFrame(turn('end'), false);
    expect(log.querySelectorAll('.msg--gru'), 'one clean recovered bubble').toHaveLength(1);
    const recovered = allText(log);
    expect(recovered).not.toContain('|');
    expect(recovered).not.toContain('```');
    expect(recovered).not.toContain('``');
    expect(recovered).not.toContain('connection lost');
    expect(log.querySelector('table.md-table')).not.toBeNull();
    expect(log.querySelector('pre.md-code')).not.toBeNull();
  });

  it('a same-page reconnect (partial replay: bare deltas, no turn:start) loses NO text', () => {
    // Perkins r1 blocker / r2 blocker 1 — the REAL reconnect path, as
    // wired: chat-client re-auths with last_seen_seq > 0, the server
    // replays ONLY unseen frames (no turn:start re-delivery, no reset),
    // and the replayed bare deltas arrive with streamingBody === null.
    // The first one was silently wiped when `streamText +=` ran before
    // openStream()'s reset — this test was RED until that reorder landed.
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), true);
    // Live: the reply's head lands, then the socket drops mid-turn.
    view.addFrame(delta('| Lane | State |'), true);
    view.addFrame(delta('\n|---|---|'), true);
    view.markStreamIncomplete();

    // Same-page reconnect: partial replay delivers ONLY the unseen tail
    // as bare deltas, then the never-delivered turn:end.
    const log = document.getElementById('chat-log') as HTMLElement;
    view.addFrame(delta('| e1 | done |'), false);
    view.addFrame(delta('\n| e2 | park |'), false);
    view.addFrame(turn('end'), false);

    // NO TEXT LOST — every chunk of the reply is in the DOM (the first
    // replayed delta '| e1 | done |' is exactly what the desync wiped).
    const text = allText(log);
    expect(text).toContain('Lane');
    expect(text).toContain('State');
    expect(text, 'the first replayed delta survives').toContain('e1');
    expect(text, 'the first replayed delta survives').toContain('done');
    expect(text).toContain('e2');
    expect(text).toContain('park');
    // The drop state is legible and the tail settles (turn:end delivered).
    expect(text).toMatch(/connection lost/i);
    const bubbles = [...log.querySelectorAll('.msg--gru')];
    expect(bubbles.every((b) => !b.classList.contains('msg--streaming'))).toBe(true);
    // Raw-markdown invariant holds across the split reply's bubbles:
    // pipe-leading lines render as table rows in BOTH.
    expect(text).not.toContain('|');
    expect(text).not.toContain('```');
    for (const bubble of bubbles) {
      expect(bubble.querySelector('table.md-table'), 'each bubble renders structure').not.toBeNull();
    }
  });

  it('a held streaming fragment resolves at turn end (the final render is load-bearing)', () => {
    // Perkins r1 warning 8 ("blocker" mislabel noted above): closeStream's
    // non-streaming final render was unpinned — deleting it kept every
    // earlier DOM test green. This test fails if that render goes away:
    // the held fragment must materialize (as literal text per GFM, never
    // as an empty fence) once the turn ends.
    const view = new ChatView(() => {});
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(delta('status: ok\n``'), true);
    const log = document.getElementById('chat-log') as HTMLElement;
    let text = allText(log);
    expect(text).toContain('status: ok');
    expect(text, 'mid-stream: partial marker is held').not.toContain('``');

    view.addFrame(turn('end'), true);

    text = allText(log);
    expect(text, 'turn end: held fragment materializes as literal text').toContain('``');
    expect(log.querySelector('pre'), 'a lone `` is text, not a fence').toBeNull();
    expect(log.querySelector('.msg--gru')?.classList.contains('msg--streaming')).toBe(false);
  });
});
