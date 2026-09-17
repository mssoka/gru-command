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
import { ToastStack } from './ui/toast.js';
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
/** E7: the live toast surface — one stack, reused across re-pairs. */
const toastStack = new ToastStack(document.getElementById('toasts'));
/** E7: browser Notification permission — requested on the pair gesture,
 * used opportunistically when granted (toasts remain the in-app floor). */
let browserNotifications: NotificationPermission = typeof Notification === 'undefined' ? 'denied' : Notification.permission;

function requestBrowserNotifications(): void {
  if (typeof Notification === 'undefined') return;
  browserNotifications = Notification.permission;
  if (browserNotifications === 'default') {
    void Notification.requestPermission().then((permission) => {
      browserNotifications = permission;
    });
  }
}

/** The live notification surface (E7): toast ALWAYS (in-app floor) +
 * browser notification when permission was granted. */
function surfaceNotification(notification: { id: string; title: string; detail: string | null; severity: string }): void {
  toastStack.show({
    id: notification.id,
    title: notification.title,
    detail: notification.detail,
    severity: notification.severity === 'error' ? 'error' : 'info',
    onShown: () => {
      /* the receipt is sent by BoardView.sendShown (it owns the client) */
    },
  });
  if (browserNotifications === 'granted') {
    try {
      const browserNotification = new Notification(notification.title, {
        body: notification.detail ?? undefined,
        tag: notification.id,
      });
      browserNotification.addEventListener('click', () => {
        window.focus();
        void browserNotification.close();
      });
    } catch {
      /* some browsers restrict constructor use — the toast already landed */
    }
  }
}
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

let activeView: ViewId = 'chat';

function switchView(id: ViewId): void {
  activeView = id;
  if (mobileQuery.matches && id === 'chat') {
    // Phone: chat lives in the corner bubble/sheet — the tab opens it.
    chatView?.openSheet();
    return;
  }
  showView(id);
}

mustGet<HTMLButtonElement>('tab-chat').addEventListener('click', () => switchView('chat'));
mustGet<HTMLButtonElement>('tab-board').addEventListener('click', () => switchView('board'));
const initialView: ViewId = mobileQuery.matches ? 'board' : 'chat';
activeView = initialView;
showView(initialView);
// Resizing across the phone/desktop breakpoint re-runs placement so the
// hidden-state invariants hold in both layouts (ChatView reparents itself).
mobileQuery.addEventListener('change', () => showView(activeView));

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

/** Transcript refresh is signature-gated: only agent identity/file
 * changes (not every snapshot push) warrant re-listing transcripts. */
let transcriptSignature = '';

function startBoard(token: string): void {
  boardView ??= new BoardView(
    (request) => {
      void transcriptView?.open({
        file: request.file,
        role: '',
        sizeBytes: 0,
        modifiedAt: '',
        agentId: null,
        agentLabel: request.label,
      });
    },
    null, // the client is bound below — one source of truth, rebound per pair
  );
  boardClient?.stop();
  boardClient = new BoardClient(
    { token, host: location.host, secure },
    {
      connection: () => {
        /* the board degrades to its last snapshot; no banner needed */
      },
      snapshot: (snapshot) => {
        boardView?.render(snapshot);
        const signature = snapshot.agents
          .map((agent) => `${agent.id}:${agent.sessionFile ?? ''}`)
          .join('|');
        if (signature !== transcriptSignature) {
          transcriptSignature = signature;
          transcriptView?.refreshList();
        }
      },
      fatal: (message) => {
        failPairing(message);
      },
    },
  );
  // E7: the view gains the live client (receipts + acks) and the toast
  // surface for newly-arrived notifications.
  boardView.bindClient(boardClient);
  boardView.setToastHandler((notification) => surfaceNotification(notification));
  // Rebound on EVERY startBoard: a re-pair mints a fresh client, and a
  // stale view holding the old client would 401-and-bounce valid sessions.
  transcriptView = new TranscriptView(boardClient, mustGet('board-transcripts'));
  boardClient.connect();
}

function pair(token: string): void {
  storage.setItem(TOKEN_KEY, token);
  requestBrowserNotifications();
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
