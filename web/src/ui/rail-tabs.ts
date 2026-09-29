/**
 * Crew-rail tabs (board UX v6.1): CREW / TRANSCRIPTS swap the rail's two
 * dense lists without leaving the cockpit. One controller, no state
 * beyond the DOM: clicking a tab flips `aria-selected` and toggles the
 * `[data-rail-panel]` sections. The CREW count itself is written by
 * BoardView (`#rail-agents-count`), never here. Internal identifiers keep
 * their stable names; only the rendered word is CREW.
 */

export class RailTabs {
  private readonly tabs: readonly HTMLButtonElement[];
  private readonly panels: readonly HTMLElement[];
  private active: string;

  constructor(root: HTMLElement) {
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-rail-tab]')];
    this.panels = [...root.querySelectorAll<HTMLElement>('[data-rail-panel]')];
    this.active = this.tabs[0]?.dataset.railTab ?? 'agents';
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.select(tab.dataset.railTab ?? ''));
    }
    this.apply();
  }

  get selected(): string {
    return this.active;
  }

  select(name: string): void {
    if (!this.tabs.some((tab) => tab.dataset.railTab === name)) return;
    this.active = name;
    this.apply();
  }

  private apply(): void {
    for (const tab of this.tabs) {
      const selected = tab.dataset.railTab === this.active;
      tab.classList.toggle('agents-rail__tab--active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    for (const panel of this.panels) {
      panel.hidden = panel.dataset.railPanel !== this.active;
    }
  }
}
