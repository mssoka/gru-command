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
});
