/**
 * Pairing screen: token entry + a QR of the LAN-pairing payload.
 * The QR payload ({"gru-command":1, url, token}) is built fully client-side
 * from location.origin + the typed token — the real payload against the
 * served UI (the mock uses the same shape).
 */

import QRCode from 'qrcode';
import { mustGet } from './dom.js';

export interface PairingPayload {
  readonly url: string;
  readonly token: string;
}

export function buildPairingPayload(url: string, token: string): string {
  return JSON.stringify({ 'gru-command': 1, url, token });
}

export function initPairing(onPair: (token: string) => void): void {
  const input = mustGet<HTMLInputElement>('pair-token');
  const form = mustGet<HTMLFormElement>('pair-form');
  const errorBox = mustGet<HTMLElement>('pair-error');
  const qrImg = mustGet<HTMLImageElement>('pair-qr-img');

  // No token prefill: the token is per-install (real service) or the
  // mock's configured dev token — either way the human pairs with what
  // THEIR instance runs, never a hardcoded guess.

  const renderQr = async (): Promise<void> => {
    const token = input.value.trim();
    const payload = buildPairingPayload(location.origin, token || '<token>');
    try {
      qrImg.src = await QRCode.toDataURL(payload, { margin: 1, width: 360 });
    } catch {
      qrImg.removeAttribute('src');
    }
  };

  input.addEventListener('input', () => {
    errorBox.hidden = true;
    void renderQr();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = input.value.trim();
    if (token === '') {
      errorBox.textContent = 'Enter the pairing token first (check the service console).';
      errorBox.hidden = false;
      return;
    }
    onPair(token);
  });

  void renderQr();
}

export function showPairingError(message: string): void {
  const errorBox = mustGet<HTMLElement>('pair-error');
  errorBox.textContent = message;
  errorBox.hidden = false;
}
