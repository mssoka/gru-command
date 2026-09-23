/**
 * Drag splitters (board UX v6): the two 4px boundaries of the cockpit —
 * [chat | board | agents-rail]. Dragging a boundary resizes the pane and
 * persists the pair per breakpoint in localStorage; double-clicking a
 * splitter resets both panes to their defaults. The controller only
 * writes CSS custom properties (`--pane-chat-width`, `--pane-rail-width`)
 * on the console root; the grid rules live in components.css.
 *
 * Behavior rules the tests pin:
 *   - drag updates the pane live (150ms grid transition bypassed while
 *     dragging, restored on release);
 *   - min widths hold at the boundary (chat 420 / board 480 / rail 240),
 *     degrading softly at the 1100px edge where the numbers sum past the
 *     viewport (see console-layout.ts);
 *   - the final size persists under `gru-pane-sizes` and survives reload;
 *   - double-click resets BOTH panes to their defaults and persists that;
 *   - keyboard: Arrow keys nudge a focused handle by 16px, Home resets.
 *
 * The handles are inert outside the cockpit breakpoint (CSS hides them);
 * the controller defensively ignores gestures there too, so a stale
 * pointer can never write a size meant for another layout.
 */

import {
  clampChatWidth,
  clampPaneSizes,
  clampRailWidth,
  consoleModeForWidth,
  defaultPaneSizes,
  loadPaneSizes,
  savePaneSizes,
  COCKPIT_MIN_WIDTH,
  type PaneSizes,
} from '../lib/console-layout.js';
import type { StorageLike } from '../theme.js';

/** Keyboard nudge per Arrow press. */
export const SPLITTER_KEY_STEP = 16;

export type SplitterSide = 'chat' | 'rail';

export interface SplitterControllerOptions {
  /** The console root carrying the CSS custom properties. */
  readonly root: HTMLElement;
  /** The chat|board boundary. */
  readonly chatHandle: HTMLElement;
  /** The board|rail boundary. */
  readonly railHandle: HTMLElement;
  readonly storage: StorageLike | null;
  /** Viewport width source (injectable for tests). */
  readonly viewportWidth?: () => number;
  /** Console container width source; falls back to viewport − page padding
   * when no layout has run (unit tests, hidden mounts). */
  readonly containerWidth?: () => number;
}

interface DragState {
  readonly side: SplitterSide;
  readonly startX: number;
  readonly startSizes: PaneSizes;
  readonly containerWidth: number;
}

function fallbackContainerWidth(viewportWidth: number): number {
  // Mirrors .app-main's side padding (20px each side) — used only before
  // the console has been laid out (hidden mount / unit tests).
  return Math.max(0, viewportWidth - 40);
}

export class SplitterController {
  private readonly root: HTMLElement;
  private readonly handles: Readonly<Record<SplitterSide, HTMLElement>>;
  private readonly storage: StorageLike | null;
  private readonly viewportWidth: () => number;
  private readonly containerWidth: () => number;
  private sizes: PaneSizes;
  private drag: DragState | null = null;

  constructor(options: SplitterControllerOptions) {
    this.root = options.root;
    this.handles = { chat: options.chatHandle, rail: options.railHandle };
    this.storage = options.storage;
    this.viewportWidth = options.viewportWidth ?? (() => window.innerWidth);
    this.containerWidth = options.containerWidth ?? (() => {
      const measured = this.root.clientWidth;
      return measured > 0 ? measured : fallbackContainerWidth(this.viewportWidth());
    });
    this.sizes = this.defaults();

    for (const side of ['chat', 'rail'] as const) {
      const handle = this.handles[side];
      handle.addEventListener('pointerdown', (event) => this.beginDrag(side, event));
      handle.addEventListener('dblclick', () => this.reset());
      handle.addEventListener('keydown', (event) => this.onKeyDown(side, event));
    }
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('resize', this.onViewportResize);
    this.apply();
  }

  /** Current (applied) pane sizes. */
  get current(): PaneSizes {
    return this.sizes;
  }

  /** Re-read the layout for a width change: cockpit keeps the persisted
   * pair (clamped to fit); other modes leave the numbers alone so crossing
   * down and back up restores the user's cockpit. */
  sync(): void {
    if (consoleModeForWidth(this.viewportWidth()) !== 'cockpit') return;
    this.sizes = this.defaults();
    this.apply();
  }

  /** Double-click reset: both panes back to their defaults, persisted. */
  reset(): void {
    this.sizes = defaultPaneSizes(this.containerWidth());
    savePaneSizes(this.storage, this.sizes);
    this.apply();
  }

  /** Storage-first sizes (clamped to the current container); defaults when
   * nothing valid is stored. */
  private defaults(): PaneSizes {
    const saved = loadPaneSizes(this.storage);
    if (saved === null) return defaultPaneSizes(this.containerWidth());
    return clampPaneSizes(saved, this.containerWidth());
  }

  private beginDrag(side: SplitterSide, event: PointerEvent): void {
    if (event.button !== 0) return;
    if (this.viewportWidth() < COCKPIT_MIN_WIDTH) return;
    // A second pointer mid-drag never hijacks the active gesture.
    if (this.drag !== null) return;
    this.drag = {
      side,
      startX: event.clientX,
      startSizes: this.sizes,
      containerWidth: this.containerWidth(),
    };
    this.root.dataset.paneDragging = 'true';
    // NOTE: no preventDefault() here — pointerdown's default action is the
    // compatibility mouse-event chain; cancelling it suppresses click AND
    // dblclick, which would kill the double-click reset on a real pointer.
    // Native panning/selection are handled by touch-action: none and the
    // transient user-select: none while dragging.
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag === null) return;
    const delta = event.clientX - drag.startX;
    if (drag.side === 'chat') {
      this.sizes = {
        chat: clampChatWidth(drag.startSizes.chat + delta, drag.containerWidth, drag.startSizes.rail),
        rail: drag.startSizes.rail,
      };
    } else {
      this.sizes = {
        chat: drag.startSizes.chat,
        rail: clampRailWidth(drag.startSizes.rail - delta, drag.containerWidth, drag.startSizes.chat),
      };
    }
    this.apply();
  };

  private readonly onPointerUp = (): void => {
    if (this.drag === null) return;
    this.drag = null;
    delete this.root.dataset.paneDragging;
    savePaneSizes(this.storage, this.sizes);
  };

  private readonly onViewportResize = (): void => {
    this.sync();
  };

  private onKeyDown(side: SplitterSide, event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? -SPLITTER_KEY_STEP : event.key === 'ArrowRight' ? SPLITTER_KEY_STEP : 0;
    if (event.key === 'Home') {
      event.preventDefault();
      this.reset();
      return;
    }
    if (step === 0) return;
    event.preventDefault();
    const container = this.containerWidth();
    if (side === 'chat') {
      this.sizes = {
        chat: clampChatWidth(this.sizes.chat + step, container, this.sizes.rail),
        rail: this.sizes.rail,
      };
    } else {
      // The rail boundary moves the opposite way: a rightward nudge grows
      // the rail (the pointer edge tracks the handle, the pane does not).
      this.sizes = {
        chat: this.sizes.chat,
        rail: clampRailWidth(this.sizes.rail - step, container, this.sizes.chat),
      };
    }
    savePaneSizes(this.storage, this.sizes);
    this.apply();
  }

  /** Write the CSS vars + separator accessibility values. */
  private apply(): void {
    this.root.style.setProperty('--pane-chat-width', `${this.sizes.chat}px`);
    this.root.style.setProperty('--pane-rail-width', `${this.sizes.rail}px`);
    this.handles.chat.setAttribute('aria-valuenow', String(this.sizes.chat));
    this.handles.rail.setAttribute('aria-valuenow', String(this.sizes.rail));
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('resize', this.onViewportResize);
  }
}
