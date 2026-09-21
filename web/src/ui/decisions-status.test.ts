// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionStatusView } from '../lib/board-protocol.js';
import { DecisionStatusCard } from './decisions-status.js';

function status(
  generation: number,
  state: DecisionStatusView['status'],
  enabled = true,
): DecisionStatusView {
  return {
    enabled,
    status: state,
    reason: state === 'degraded' ? 'provider_degraded' : null,
    model: '~typesafe/jev-latest',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    credentialPresent: enabled,
    credentialSource: enabled ? 'file' : 'none',
    checkedAt: null,
    incarnation: 'test-incarnation',
    generation,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('decision status card', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="decisions-stamp"></span>
      <p id="decisions-summary"></p>
      <div id="decisions-meta"></div>
      <div id="decisions-setup"></div>
      <button id="decisions-recheck"></button>
    `;
  });

  it('renders disabled, degraded and ready states with scoped controls', () => {
    const card = new DecisionStatusCard(() => null);
    const stamp = document.querySelector<HTMLElement>('#decisions-stamp')!;
    const button = document.querySelector<HTMLButtonElement>('#decisions-recheck')!;
    card.render(status(1, 'disabled', false));
    expect(stamp.textContent).toBe('OFF');
    expect(button.hidden).toBe(true);
    card.render(status(2, 'degraded'));
    expect(stamp.textContent).toBe('FALLBACK');
    expect(document.querySelector('#decisions-summary')?.textContent).toContain('Deterministic fallback');
    card.render(status(3, 'ready'));
    expect(stamp.textContent).toBe('READY');
    expect(document.querySelector<HTMLElement>('#decisions-setup')?.hidden).toBe(true);
  });

  it('recovers the Recheck control after a transport failure without replacing the safe status', async () => {
    const card = new DecisionStatusCard(() => Promise.reject(new Error('offline')));
    const button = document.querySelector<HTMLButtonElement>('#decisions-recheck')!;
    card.render(status(4, 'degraded'));
    button.click();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe('Recheck');
    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('FALLBACK');
    expect(document.querySelector('#decisions-summary')?.textContent).toContain('current deterministic route remains safe');
  });

  it('keeps Recheck busy across pushed snapshots and rejects an older late HTTP reply', async () => {
    const response = deferred<DecisionStatusView>();
    const card = new DecisionStatusCard(() => response.promise);
    const button = document.querySelector<HTMLButtonElement>('#decisions-recheck')!;
    card.render(status(4, 'degraded'));
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Checking…');

    card.render(status(6, 'disabled', false));
    expect(button.disabled).toBe(true);
    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('OFF');
    response.resolve(status(5, 'ready'));
    await vi.waitFor(() => expect(button.textContent).toBe('Recheck'));

    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('OFF');
    expect(button.hidden).toBe(true);
  });

  it('consumes the late recheck reply through the production recheck path: newer incarnations win, dead-incarnation replies lose', async () => {
    const response = deferred<DecisionStatusView>();
    const card = new DecisionStatusCard(() => response.promise);
    const button = document.querySelector<HTMLButtonElement>('#decisions-recheck')!;
    // Live OLD-incarnation state, ENABLED so the real recheck control is
    // usable — the late reply below is consumed through the card's own
    // click path, not by calling render directly.
    card.render({ ...status(4, 'degraded'), incarnation: 'old-process' });
    expect(button.hidden).toBe(false);
    button.click();
    expect(button.disabled).toBe(true);
    // The service restarts: a snapshot push from the NEW incarnation is the
    // live server's own state and must be followed.
    card.render({ ...status(0, 'disabled', false), incarnation: 'new-process' });
    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('OFF');
    // The stale pre-restart reply finally resolves through the recheck
    // callback — a dead incarnation must not outrank live state.
    response.resolve({ ...status(9, 'ready'), incarnation: 'old-process' });
    await vi.waitFor(() => expect(button.textContent).toBe('Recheck'));
    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('OFF');
    expect(document.querySelector('#decisions-summary')?.textContent).toContain('Deterministic routing only');
    // A reply from the LIVE incarnation is consumed normally.
    card.render({ ...status(7, 'ready'), incarnation: 'new-process' });
    expect(document.querySelector('#decisions-stamp')?.textContent).toBe('READY');
  });
});
