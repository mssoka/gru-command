/**
 * Gru Command web shell — boot & wiring (E5).
 * Pairing gate → chat against the socket; theme + banners + settings.
 */

import './styles/tokens.css';
import './styles/components.css';

import { ChatClient, type ConnectionState } from './lib/chat-client.js';
import { WS_PATH, type LoggedFrame } from './lib/protocol.js';
import { BoardClient } from './lib/board-client.js';
import { applyTheme, getTheme, setTheme } from './theme.js';
import { clearBanner, showBanner } from './ui/banner.js';
import { ChatView, renderConnectionDot } from './ui/chat.js';
import { BoardView } from './ui/board.js';
import { TranscriptView } from './ui/transcript.js';
import { mustGet } from './ui/dom.js';
import { initPairing, showPairingError } from './ui/pairing.js';
import { initSettings, THEME_EVENT } from './ui/settings.js';

const TOKEN_KEY = 'gru-pairing-token';

const storage = window.localStorage;

// Theme applies before first paint decision; default is light.
applyTheme(document, getTheme(storage));

const secure = location.protocol === 'https:';
const wsUrl = `${secure ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;

let client: ChatClient | null = null;
let chatView: ChatView | null = null;
let boardClient: BoardClient | null = null;
let boardView: BoardView | null = null;
let transcriptView: TranscriptView | null = null;
/** First fatal wins: chat + board share one token, so both sockets fail
 * together — the user sees ONE pairing error, not two racing rewrites. */
let pairingFailed = false;

function failPairing(message: string): void {
  if (pairingFailed) return;
  pairingFailed = true;
  clearBanner('conn');
  storage.removeItem(TOKEN_KEY);
  showPairing();
  showPairingError(`Pairing failed: ${message}`);
}

// ---------------------------------------------------------------------
// Views: desktop defaults to chat; a phone opens board-first (SPEC
// ruling 11 — the board is the dashboard, chat is the corner bubble).
// ---------------------------------------------------------------------

const mobileQuery = window.matchMedia('(max-width: 768px)');
type ViewId = 'chat' | 'board';

function showView(id: ViewId): void {
  // On a phone the chat panel lives inside the bottom SHEET (its own
  // open/close mechanics) — the section itself must stay un-hidden there
  // or the sheet's input goes invisible; the desktop mount is tab-toggled.
  if (!mobileQuery.matches) {
    mustGet('chat-view').hidden = id !== 'chat';
    mustGet('chat-main-mount').hidden = id !== 'chat';
  }
  mustGet('board-view').hidden = id !== 'board';
  mustGet('tab-chat').classList.toggle('app-nav__tab--active', id === 'chat');
  mustGet('tab-board').classList.toggle('app-nav__tab--active', id === 'board');
}

/** Pairing replaces the whole app surface (it precedes any authed view). */
function showPairing(): void {
  mustGet('pairing-view').hidden = false;
  if (!mobileQuery.matches) {
    mustGet('chat-view').hidden = true;
    mustGet('chat-main-mount').hidden = true;
  }
  mustGet('board-view').hidden = true;
}

mustGet<HTMLButtonElement>('tab-chat').addEventListener('click', () => {
  if (mobileQuery.matches) chatView?.openSheet(); // phone: chat IS the bubble
  else showView('chat');
});
mustGet<HTMLButtonElement>('tab-board').addEventListener('click', () => showView('board'));
const initialView: ViewId = mobileQuery.matches ? 'board' : 'chat';
showView(initialView);

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
  pairingFailed = false;
  mustGet('pairing-view').hidden = true;
  // The chat SECTION must be un-hidden in both layouts: on desktop the
  // main mount shows it; on a phone the panel is reparented into the
  // bottom sheet whose own open/close mechanics govern visibility.
  mustGet('chat-view').hidden = false;
  if (!mobileQuery.matches) showView('chat');
  else showView('board');
  chatView ??= new ChatView((text) => client?.send(text));
  client?.stop();
  let replaying = false;
  client = new ChatClient(
    { token, host: location.host, secure, storage },
    {
      connection: onConnection,
      messageStatus: (message) => chatView?.upsertMessage(message),
      frame: (frame: LoggedFrame) => chatView?.addFrame(frame, !replaying),
      replayStart: (full) => {
        replaying = true;
        if (full) {
          chatView?.reset();
          // reset() wipes the DOM — re-render locally-queued bubbles so a
          // never-delivered typed word stays visible during replay.
          for (const message of client?.getMessages() ?? []) {
            if (message.status !== 'acked') chatView?.upsertMessage({ ...message });
          }
        }
      },
      replayEnd: () => {
        replaying = false;
      },
      fatal: (message) => {
        failPairing(message);
      },
    },
  );
  client.connect();
  startBoard(token);
}

function startBoard(token: string): void {
  boardView ??= new BoardView((request) => {
    void transcriptView?.open({
      file: request.file,
      role: '',
      sizeBytes: 0,
      modifiedAt: '',
      agentId: null,
      agentLabel: request.label,
    });
  });
  boardClient?.stop();
  boardClient = new BoardClient(
    { token, host: location.host, secure },
    {
      connection: () => {
        /* the board degrades to its last snapshot; no banner needed */
      },
      snapshot: (snapshot) => {
        boardView?.render(snapshot);
        transcriptView?.refreshList();
      },
      fatal: (message) => {
        failPairing(message);
      },
    },
  );
  transcriptView ??= new TranscriptView(boardClient, mustGet('board-transcripts'));
  boardClient.connect();
}

function pair(token: string): void {
  storage.setItem(TOKEN_KEY, token);
  startChat(token);
}

// Theme toggles stay in sync via a window event (nav + settings).
function applyThemeChoice(theme: 'light' | 'dark'): void {
  setTheme(storage, theme);
  applyTheme(document, theme);
  mustGet<HTMLButtonElement>('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

mustGet<HTMLButtonElement>('theme-toggle').addEventListener('click', () => {
  applyThemeChoice(getTheme(storage) === 'dark' ? 'light' : 'dark');
});
mustGet<HTMLButtonElement>('theme-toggle').textContent =
  getTheme(storage) === 'dark' ? '☀️' : '🌙';

initPairing(pair);
initSettings({
  storage,
  wsUrl,
  onUnpair: () => {
    client?.stop();
    boardClient?.stop();
    client = null;
    boardClient = null;
    storage.removeItem(TOKEN_KEY);
    location.reload();
  },
});

const savedToken = storage.getItem(TOKEN_KEY);
if (savedToken !== null && savedToken !== '') {
  startChat(savedToken);
} else {
  showPairing();
}
