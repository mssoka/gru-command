/**
 * Gru Command web shell — boot & wiring (E5).
 * Pairing gate → chat against the socket; theme + banners + settings.
 */

import './styles/tokens.css';
import './styles/components.css';

import { ChatClient, type ConnectionState } from './lib/chat-client.js';
import { WS_PATH, type LoggedFrame } from './lib/protocol.js';
import { applyTheme, getTheme, setTheme } from './theme.js';
import { clearBanner, showBanner } from './ui/banner.js';
import { ChatView, renderConnectionDot } from './ui/chat.js';
import { mustGet } from './ui/dom.js';
import { initPairing, showPairingError } from './ui/pairing.js';
import { initSettings } from './ui/settings.js';

const TOKEN_KEY = 'gru-pairing-token';

const storage = window.localStorage;

// Theme applies before first paint decision; default is light.
applyTheme(document, getTheme(storage));

const secure = location.protocol === 'https:';
const wsUrl = `${secure ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;

let client: ChatClient | null = null;
let chatView: ChatView | null = null;

function showView(id: 'pairing-view' | 'chat-view'): void {
  mustGet('pairing-view').hidden = id !== 'pairing-view';
  mustGet('chat-view').hidden = id !== 'chat-view';
}

function onConnection(state: ConnectionState): void {
  renderConnectionDot(state);
  if (state === 'reconnecting' || state === 'offline') {
    chatView?.markStreamIncomplete();
    showBanner(
      'conn',
      'work',
      state === 'reconnecting'
        ? 'Reconnecting to Gru — messages queue safely…'
        : 'Connection lost — typed words are queued, never lost.',
    );
  } else if (state === 'connecting' || state === 'authenticating') {
    showBanner('conn', 'info', 'Connecting to Gru…');
  } else if (state === 'open') {
    clearBanner('conn');
  }
}

function startChat(token: string): void {
  showView('chat-view');
  chatView ??= new ChatView((text) => client?.send(text));
  client?.stop();
  client = new ChatClient(
    { token, host: location.host, secure, storage },
    {
      connection: onConnection,
      messageStatus: (message) => chatView?.upsertMessage(message),
      frame: (frame: LoggedFrame) => chatView?.addFrame(frame, true),
      replayStart: (full) => {
        if (full) chatView?.reset();
      },
      replayEnd: () => {},
      fatal: (message) => {
        storage.removeItem(TOKEN_KEY);
        showView('pairing-view');
        showPairingError(`Pairing failed: ${message}`);
      },
    },
  );
  client.connect();
}

function pair(token: string): void {
  storage.setItem(TOKEN_KEY, token);
  startChat(token);
}

// Theme toggle in the nav mirrors the settings one.
mustGet<HTMLButtonElement>('theme-toggle').addEventListener('click', () => {
  const next = getTheme(storage) === 'dark' ? 'light' : 'dark';
  setTheme(storage, next);
  applyTheme(document, next);
  mustGet<HTMLButtonElement>('theme-toggle').textContent = next === 'dark' ? '☀️' : '🌙';
});
mustGet<HTMLButtonElement>('theme-toggle').textContent =
  getTheme(storage) === 'dark' ? '☀️' : '🌙';

initPairing(pair);
initSettings({
  storage,
  wsUrl,
  onUnpair: () => {
    client?.stop();
    client = null;
    storage.removeItem(TOKEN_KEY);
    location.reload();
  },
});

const savedToken = storage.getItem(TOKEN_KEY);
if (savedToken !== null && savedToken !== '') {
  startChat(savedToken);
} else {
  showView('pairing-view');
}
