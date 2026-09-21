/**
 * Board client (E6): fetches the snapshot over the authenticated HTTP API
 * and keeps it live via the /board/ws push. Reconnects with backoff; a
 * reconnect refetches the snapshot from HTTP first (the WS push starts
 * from a fresh auth anyway — snapshots are idempotent, so there is no
 * replay contract to honor).
 */

import {
  BOARD_WS_PATH,
  isValidDecisionStatus,
  isValidSnapshot,
  parseBoardServerFrame,
  type BoardSnapshot,
  type DecisionStatusView,
  type TranscriptInfo,
  type TranscriptPage,
  type TranscriptSearchResult,
} from './board-protocol.js';

export type BoardConnectionState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'offline';

export interface BoardClientEvents {
  connection(state: BoardConnectionState): void;
  snapshot(snapshot: BoardSnapshot): void;
  /** Fatal (bad token) — pairing must redo. */
  fatal(message: string): void;
}

export interface BoardClientOptions {
  readonly token: string;
  readonly host: string;
  readonly secure?: boolean;
  readonly webSocketCtor?: new (url: string) => WebSocket;
  readonly fetchImpl?: typeof fetch;
}

const BACKOFF_MS = [800, 1_600, 3_200, 6_400, 12_000] as const;

export class BoardClient {
  private socket: WebSocket | null = null;
  private state: BoardConnectionState = 'idle';
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: BoardClientOptions;
  private readonly webSocketCtor: new (url: string) => WebSocket;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: BoardClientOptions,
    private readonly events: BoardClientEvents,
  ) {
    this.options = options;
    this.webSocketCtor = options.webSocketCtor ?? WebSocket;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getState(): BoardConnectionState {
    return this.state;
  }

  private setState(state: BoardConnectionState): void {
    this.state = state;
    this.events.connection(state);
  }

  connect(): void {
    this.stopped = false;
    void this.refetchSnapshot();
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState('offline');
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ws = new this.webSocketCtor(
      `${this.options.secure === true ? 'wss' : 'ws'}://${this.options.host}${BOARD_WS_PATH}`,
    );
    this.socket = ws;
    ws.onopen = () => {
      this.setState('authenticating');
      ws.send(JSON.stringify({ type: 'auth', token: this.options.token }));
    };
    ws.onmessage = (event: MessageEvent) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return; // ignore noise; the snapshot contract has no half-frames
      }
      const frame = parseBoardServerFrame(raw);
      if (frame === null) return;
      if (frame.type === 'auth_ok') {
        this.attempts = 0;
        this.setState('open');
        return;
      }
      if (frame.type === 'board') {
        this.events.snapshot(frame.snapshot);
        return;
      }
      if (frame.fatal) {
        this.stop();
        this.events.fatal(frame.message);
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    const backoff = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    const delay = backoff ?? 12_000;
    this.attempts += 1;
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        void this.refetchSnapshot(); // catch up on what was missed
        this.openSocket();
      }
    }, delay);
  }

  private async api<T>(path: string): Promise<T> {
    // Relative paths: the API is served from the same origin as the UI in
    // production, and vite's dev proxy carries /api to the mock.
    const doFetch = this.fetchImpl;
    const res = await doFetch(path, {
      headers: { authorization: `Bearer ${this.options.token}` },
    });
    if (!res.ok) {
      if (res.status === 401) {
        this.events.fatal('unauthorized (board api)');
      }
      throw new Error(`board api ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** One-shot HTTP snapshot fetch (initial load + reconnect catch-up). */
  async refetchSnapshot(): Promise<void> {
    try {
      const snapshot = await this.api<unknown>('/api/board');
      if (!isValidSnapshot(snapshot)) throw new Error('board api returned a malformed snapshot');
      this.events.snapshot(snapshot);
    } catch {
      /* connection state carries the error surface */
    }
  }

  /** Re-run the bounded decision-provider startup check; no credential crosses HTTP. */
  async recheckDecisions(): Promise<DecisionStatusView> {
    const response = await this.postApi('/api/decisions/recheck', {});
    if (!isValidDecisionStatus(response)) throw new Error('decision recheck returned a malformed status');
    return response;
  }

  listTranscripts(): Promise<{ transcripts: readonly TranscriptInfo[] }> {
    return this.api<{ transcripts: readonly TranscriptInfo[] }>('/api/transcripts');
  }

  pageTranscript(file: string, opts: { before?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const params = new URLSearchParams({ file });
    if (opts.before !== undefined) params.set('before', String(opts.before));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    return this.api<TranscriptPage>(`/api/transcripts/file?${params.toString()}`);
  }

  searchTranscript(file: string, query: string): Promise<TranscriptSearchResult> {
    const params = new URLSearchParams({ file, q: query });
    return this.api<TranscriptSearchResult>(`/api/transcripts/file?${params.toString()}`);
  }

  /** E7: display receipt (shown:true doctrine) — idempotent per surface.
   * Resolves true when the receipt landed; false on failure (the caller
   * unmarks so a later surface upgrade retries). */
  async markNotificationShown(id: string, surface: string): Promise<boolean> {
    try {
      await this.postApi(`/api/notifications/${encodeURIComponent(id)}/shown`, { surface });
      return true;
    } catch {
      return false; // a lost receipt never blocks rendering
    }
  }

  /** E7: human ack (action-required clearance; re-arms an open breaker). */
  async ackNotification(id: string): Promise<void> {
    await this.postApi(`/api/notifications/${encodeURIComponent(id)}/ack`, { by: 'web' });
  }

  private async postApi(path: string, body: unknown): Promise<unknown> {
    const doFetch = this.fetchImpl;
    const res = await doFetch(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) {
        this.events.fatal('unauthorized (board api)');
      }
      throw new Error(`board api ${path} → ${res.status}`);
    }
    return res.json();
  }
}
