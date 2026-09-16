/** Degraded-mode banners: one stack, keyed so each condition shows once. */

import { el, mustGet } from './dom.js';

export type BannerKind = 'work' | 'alert' | 'info';

const KIND_CLASS: Record<BannerKind, string> = {
  work: 'banner',
  alert: 'banner banner--alert',
  info: 'banner banner--info',
};

const shown = new Map<string, HTMLElement>();

export function showBanner(key: string, kind: BannerKind, message: string): void {
  const existing = shown.get(key);
  if (existing) {
    // Same condition, new wording (e.g. reconnecting → offline): update.
    const textNode = existing.lastElementChild;
    if (textNode) textNode.textContent = message;
    existing.className = KIND_CLASS[kind];
    return;
  }
  const node = el('div', KIND_CLASS[kind]);
  node.setAttribute('role', 'status');
  node.dataset.bannerKey = key;
  node.append(el('span', '', kind === 'alert' ? '🚨' : kind === 'info' ? 'ℹ️' : '⏳'));
  node.append(el('span', '', message));
  mustGet('banners').append(node);
  shown.set(key, node);
}

export function clearBanner(key: string): void {
  const node = shown.get(key);
  if (node) {
    node.remove();
    shown.delete(key);
  }
}
