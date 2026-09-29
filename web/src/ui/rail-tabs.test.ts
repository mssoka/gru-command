// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { RailTabs } from './rail-tabs.js';

function mount(): HTMLElement {
  document.body.innerHTML = `
    <aside id="agents-rail">
      <button data-rail-tab="agents" class="agents-rail__tab agents-rail__tab--active" aria-selected="true">CREW <span id="rail-agents-count">0</span></button>
      <button data-rail-tab="transcripts" class="agents-rail__tab" aria-selected="false">TRANSCRIPTS</button>
      <div data-rail-panel="agents"></div>
      <div data-rail-panel="transcripts" hidden></div>
    </aside>`;
  return document.getElementById('agents-rail') as HTMLElement;
}

let root: HTMLElement;
beforeEach(() => {
  root = mount();
});

describe('agents-rail tabs (v6)', () => {
  it('starts on AGENTS with the transcripts panel hidden', () => {
    new RailTabs(root);
    expect(root.querySelector('[data-rail-panel="agents"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-rail-panel="transcripts"]')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-rail-tab="agents"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a tab flips selection, active class, and panel visibility', () => {
    const tabs = new RailTabs(root);
    expect(tabs.selected).toBe('agents');
    (root.querySelector('[data-rail-tab="transcripts"]') as HTMLButtonElement).click();
    expect(tabs.selected).toBe('transcripts');
    expect(root.querySelector('[data-rail-panel="agents"]')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-rail-panel="transcripts"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-rail-tab="transcripts"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[data-rail-tab="agents"]')?.getAttribute('aria-selected')).toBe('false');
    expect(root.querySelector('[data-rail-tab="transcripts"]')?.classList.contains('agents-rail__tab--active')).toBe(true);

    (root.querySelector('[data-rail-tab="agents"]') as HTMLButtonElement).click();
    expect(tabs.selected).toBe('agents');
    expect(root.querySelector('[data-rail-panel="agents"]')?.hasAttribute('hidden')).toBe(false);
  });

  it('an unknown select is a no-op', () => {
    const tabs = new RailTabs(root);
    tabs.select('nonsense');
    expect(tabs.selected).toBe('agents');
  });
});
