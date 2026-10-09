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
  type NotificationView,
  type TranscriptInfo,
  type TranscriptPage,
  type TranscriptSearchResult,
} from './board-protocol.js';

export interface ReceiptPage {
  readonly receipts: readonly NotificationView[];
  readonly nextOffset: number;
  readonly hasMore: boolean;
}

export type BoardConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'open'
  /** No inbound frame inside the liveness window — the socket is presumed
   * dead (sleep-killed/zombie) and recovery is already under way. */
  | 'stale'
  | 'reconnecting'
  | 'offline';

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
  /** No inbound frame for this long ⇒ the socket is presumed dead.
   * Default 2.5× the server's 30 s ping cadence. */
  readonly livenessWindowMs?: number;
  /** How often the liveness clock is checked. */
  readonly livenessCheckMs?: number;
}

const BACKOFF_MS = [800, 1_600, 3_200, 6_400, 12_000] as const;
const DEFAULT_LIVENESS_WINDOW_MS = 75_000;
const DEFAULT_LIVENESS_CHECK_MS = 5_000;
/** R7-05: the shared request deadline — a snapshot GET (fetch AND body)
 * that outlives it is abandoned, and every POST (owner actions) rides the
 * same bound so an action that outlives it is unconfirmed, never replayed. */
const SNAPSHOT_DEADLINE_MS = 15_000;
/** R7-04: trailing refetches run back to back this many times in a chain... */
const TRAILING_BURST = 2;
/** ...then wait, capped — owed demand is kept, never dropped. */
const TRAILING_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

/** The wait before trailing refetch number `run + 1` of one chain. */
function trailingDelay(run: number): number {
  if (run < TRAILING_BURST) return 0;
  return TRAILING_BACKOFF_MS[Math.min(run - TRAILING_BURST, TRAILING_BACKOFF_MS.length - 1)] ?? 8_000;
}

export class BoardClient {
  private socket: WebSocket | null = null;
  private state: BoardConnectionState = 'idle';
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last inbound frame (any parsed frame, incl. server pings). */
  private lastFrameAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options: BoardClientOptions;
  private readonly webSocketCtor: new (url: string) => WebSocket;
  private readonly fetchImpl: typeof fetch;
  /** Pushed snapshots seen: an HTTP answer asked for before a push is stale. */
  private snapshotEpoch = 0;
  /** The newest HTTP snapshot request; older answers are dropped. */
  private fetchSeq = 0;
  /** One trailing refetch is in flight or waiting (C13); later discards coalesce. */
  private trailingRefetch = false;
  /** An authoritative answer is owed: set by a discarded answer, met only
   * by a delivered one (R8-02) or stop(). */
  private refreshOwed = false;
  /** Trailing refetches started in the current chain (R7-04). */
  private trailingRun = 0;
  /** A trailing refetch waiting out its backoff (R7-04). */
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by stop(): a chain from before it never acts again. */
  private trailingGeneration = 0;
  /** In-flight snapshot requests, cancelled by stop() (R7-05). */
  private readonly snapshotRequests = new Set<AbortController>();
  /** Every other request this client owns (bounded GETs and POSTs), so
   * stop() cancels an owner action or drawer fetch mid-flight too. */
  private readonly requestControllers = new Set<AbortController>();

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
    this.startLivenessWatch();
    void this.refetchSnapshot();
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Queued and in-flight snapshot work belongs to this session (R7-04/05).
    if (this.trailingTimer !== null) clearTimeout(this.trailingTimer);
    this.trailingTimer = null;
    this.trailingGeneration += 1;
    this.trailingRefetch = false;
    this.refreshOwed = false;
    this.trailingRun = 0;
    for (const request of this.snapshotRequests) request.abort();
    this.snapshotRequests.clear();
    for (const request of this.requestControllers) request.abort();
    this.requestControllers.clear();
    this.stopLivenessWatch();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    this.setState('offline');
  }

  /**
   * Wake hook (document visibilitychange → visible, window 'online').
   * Refetches the snapshot unconditionally — a phone that slept for an
   * hour must show now, not the frozen frame — and re-verifies socket
   * liveness: a socket silent past the window is force-reopened, and a
   * pending backoff timer is accelerated instead of waited out.
   */
  wake(): void {
    if (this.stopped) return;
    void this.refetchSnapshot();
    if (this.socket !== null) {
      if (Date.now() - this.lastFrameAt > this.livenessWindowMs) this.forceReopen();
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.openSocket();
    }
  }

  private get livenessWindowMs(): number {
    return this.options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  }

  private startLivenessWatch(): void {
    if (this.livenessTimer !== null) return;
    this.livenessTimer = setInterval(
      () => this.checkLiveness(),
      this.options.livenessCheckMs ?? DEFAULT_LIVENESS_CHECK_MS,
    );
  }

  private stopLivenessWatch(): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  /** A socket with no inbound frame past the window is presumed dead —
   * sleep-killed sockets fire no close event, so waiting on onclose is how
   * the board used to freeze. Force the reopen; the reconnect path
   * refetches the snapshot and the board resumes without a manual reload. */
  private checkLiveness(): void {
    if (this.stopped || this.socket === null) return;
    if (Date.now() - this.lastFrameAt <= this.livenessWindowMs) return;
    this.setState('stale');
    this.forceReopen(true);
  }

  /** Detach and close the current socket, then schedule the standard
   * reconnect (refetch + reopen). Detaching matters: a zombie close() may
   * never fire, and a late onclose must not double-schedule. When
   * `fromStale` is set the 'stale' state persists through the backoff so
   * the dot shows why the board is behind. */
  private forceReopen(fromStale = false): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    this.scheduleReconnect(fromStale);
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ws = new this.webSocketCtor(
      `${this.options.secure === true ? 'wss' : 'ws'}://${this.options.host}${BOARD_WS_PATH}`,
    );
    this.socket = ws;
    this.lastFrameAt = Date.now();
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.setState('authenticating');
      ws.send(JSON.stringify({ type: 'auth', token: this.options.token }));
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.socket !== ws) return; // stale socket from a prior attempt
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return; // ignore noise; the snapshot contract has no half-frames
      }
      const frame = parseBoardServerFrame(raw);
      if (frame === null) return;
      // ANY parsed frame proves the socket is alive — pings included.
      this.lastFrameAt = Date.now();
      if (this.state === 'stale') this.setState('reconnecting');
      if (frame.type === 'auth_ok') {
        this.attempts = 0;
        this.setState('open');
        return;
      }
      if (frame.type === 'board') {
        this.snapshotEpoch += 1;
        this.events.snapshot(frame.snapshot);
        return;
      }
      if (frame.type === 'ping') return;
      if (frame.fatal) {
        this.stop();
        this.events.fatal(frame.message);
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return; // already force-reopened
      this.socket = null;
      if (this.stopped) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(keepStaleState = false): void {
    const backoff = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    const delay = backoff ?? 12_000;
    this.attempts += 1;
    if (!keepStaleState) this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        void this.refetchSnapshot(); // catch up on what was missed
        this.openSocket();
      }
    }, delay);
  }

  private async api<T>(path: string, signal?: AbortSignal): Promise<T> {
    // Relative paths: the API is served from the same origin as the UI in
    // production, and vite's dev proxy carries /api to the mock.
    //
    // Every GET is bounded: a caller that supplies its own signal (the
    // snapshot, whose controller stop() aborts) keeps it; otherwise this
    // client owns a deadline controller tracked with the POSTs, so no
    // drawer/receipt/transcript fetch can hang forever and re-pairing
    // cancels it.
    const doFetch = this.fetchImpl;
    if (signal !== undefined) {
      // The caller owns the bound (the snapshot's own deadline controller:
      // stop() aborts it). Do not invent a second, unused timer here.
      const res = await doFetch(path, { headers: { authorization: `Bearer ${this.options.token}` }, signal });
      if (!res.ok) return this.refused(path, res);
      return (await res.json()) as T;
    }
    // This client owns the request (drawer/receipt/transcript GETs): bound
    // it and register it so stop() cancels it on a re-pair.
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_DEADLINE_MS);
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new BoardApiError(path, 0, 'timeout', 'no answer before the deadline — outcome unconfirmed')),
        { once: true },
      );
    });
    try {
      return await Promise.race([
        (async () => {
          const res = await doFetch(path, {
            headers: { authorization: `Bearer ${this.options.token}` },
            signal: controller.signal,
          });
          if (!res.ok) return this.refused(path, res);
          return (await res.json()) as T;
        })(),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
      this.requestControllers.delete(controller);
    }
  }

  /** A non-2xx answer as a BoardApiError with the server's reason. A
   * stopped client's late 401 never unpairs the session that replaced it —
   * it belongs to the old pairing. */
  private async refused(path: string, res: Response): Promise<never> {
    // A refused pairing ends this client AT ONCE (R10-01) — before its error
    // body is read (which may never finish): stop() cancels the refresh
    // chain, its debt, any waiting retry and every in-flight request, so
    // nothing polls after a fatal answer.
    if (res.status === 401 && !this.stopped) {
      this.stop();
      this.events.fatal('unauthorized (board api)');
    }
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; detail?: unknown };
      code = typeof body.error === 'string' ? body.error : null;
      detail = typeof body.detail === 'string' ? body.detail : null;
    } catch {
      /* a non-JSON error body keeps the status alone */
    }
    throw new BoardApiError(path, res.status, code, detail);
  }

  /** One-shot HTTP snapshot fetch (initial load + reconnect catch-up). */
  async refetchSnapshot(): Promise<void> {
    if (this.stopped) return; // a stopped (re-paired) client never re-polls
    const request = ++this.fetchSeq;
    const epoch = this.snapshotEpoch;
    try {
      const snapshot = await this.snapshotWithinDeadline();
      if (!isValidSnapshot(snapshot)) throw new Error('board api returned a malformed snapshot');
      // Only the newest answer, and only if no pushed snapshot arrived since
      // it was asked for: an older HTTP answer never overwrites newer truth.
      // A stopped (re-paired) client's late answer never reaches the board.
      if (this.stopped || request !== this.fetchSeq) return;
      if (epoch === this.snapshotEpoch) {
        this.events.snapshot(snapshot);
        this.demandMet();
      } else {
        // C13: the push that won may itself be OLDER (queued before a
        // decision this answer already shows). The authoritative answer is
        // owed until one is delivered (R8-02) — asked for by one coalesced
        // trailing refetch; a refetch already trailing keeps it (R6-04).
        this.refreshOwed = true;
        if (!this.trailingRefetch) this.startTrailingRefetch();
      }
    } catch (error) {
      // The connection state carries the error surface. The newest request
      // failing or timing out still owes its answer (R9-01): it is asked
      // for again through the same bounded trailing chain. A refused
      // pairing (401) is fatal, never retried; an older request's failure
      // is covered by the newer one.
      if (this.stopped || request !== this.fetchSeq) return;
      if (error instanceof BoardApiError && error.status === 401) return;
      this.refreshOwed = true;
      if (!this.trailingRefetch) this.startTrailingRefetch();
    }
  }

  /** GET /api/board, fetch and body alike, bounded by a private deadline
   * (R7-05): a hung request is cancelled and rejects, so the trailing
   * refetch it holds is released and owed demand drains. */
  private async snapshotWithinDeadline(): Promise<unknown> {
    const request = new AbortController();
    this.snapshotRequests.add(request);
    const expired = new Promise<never>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('board snapshot request abandoned')), { once: true });
    });
    const timer = setTimeout(() => request.abort(), SNAPSHOT_DEADLINE_MS);
    try {
      return await Promise.race([this.api<unknown>('/api/board', request.signal), expired]);
    } finally {
      clearTimeout(timer);
      this.snapshotRequests.delete(request);
    }
  }

  /** A newest, epoch-matched answer landed: every owed refresh is met, and
   * a trailing refetch still waiting out its backoff is cancelled (R8-02). */
  private demandMet(): void {
    this.refreshOwed = false;
    if (this.trailingTimer === null) return;
    clearTimeout(this.trailingTimer);
    this.trailingTimer = null;
    this.trailingRefetch = false;
    this.trailingRun = 0;
  }

  private startTrailingRefetch(): void {
    const generation = this.trailingGeneration;
    this.trailingRefetch = true;
    this.trailingRun += 1;
    void this.refetchSnapshot().finally(() => {
      if (generation !== this.trailingGeneration) return; // stop() released the chain
      if (!this.refreshOwed || this.stopped) {
        this.trailingRefetch = false;
        this.trailingRun = 0;
        return;
      }
      // Still owed: discarded again, failed, timed out or superseded by a
      // request that has not delivered (R8-02). R7-04: under sustained
      // pushes every answer is discarded; a short burst runs back to back,
      // then the chain backs off (capped), so a GET never loops unbounded.
      const delay = trailingDelay(this.trailingRun);
      if (delay === 0) {
        this.startTrailingRefetch();
        return;
      }
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        if (generation === this.trailingGeneration && !this.stopped) this.startTrailingRefetch();
      }, delay);
    });
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

  /** D3: paged closed-receipt history for the bell's FEED section. The
   * snapshot carries only the newest receipt window; this fetches older
   * pages on demand with the raw-row offset cursor. */
  fetchReceipts(offset = 0, limit = 30): Promise<ReceiptPage> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.api<ReceiptPage>(`/api/notifications/receipts?${params.toString()}`);
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

  /** Every POST rides the same bounded deadline budget as the snapshot
   * GET: an owner action that outlives it is unconfirmed — never
   * auto-replayed; the authoritative snapshot reconciles. The deadline
   * rides a controller this client owns (not `AbortSignal.timeout`), so
   * stop()/tests share one mechanism, and the expiry surfaces as a
   * BoardApiError (code `timeout`, status 0 = no HTTP answer) — callers
   * can tell "the server said no" from "we don't know". */
  private async postApi(path: string, body: unknown): Promise<unknown> {
    const doFetch = this.fetchImpl;
    const request = new AbortController();
    this.requestControllers.add(request);
    const expired = new Promise<never>((_, reject) => {
      request.signal.addEventListener(
        'abort',
        () => reject(new BoardApiError(path, 0, 'timeout', 'no answer before the deadline — outcome unconfirmed')),
        { once: true },
      );
    });
    const timer = setTimeout(() => request.abort(), SNAPSHOT_DEADLINE_MS);
    try {
      // The deadline covers the FETCH and the BODY: a reply whose headers
      // arrive and whose body stalls is the same unconfirmed outcome as no
      // reply at all, and surfaces the same typed timeout.
      return await Promise.race([
        (async () => {
          const res = await doFetch(path, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.options.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: request.signal,
          });
          if (!res.ok) return this.refused(path, res);
          return await res.json();
        })(),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
      this.requestControllers.delete(request);
    }
  }
}

/** A board API refusal with the server's reason: the HTTP status, its
 * error code and detail. A fetch failure (network ambiguity) is never one
 * of these — callers can tell "the server said no" from "we don't know". */
export class BoardApiError extends Error {
  readonly path: string;
  readonly status: number;
  readonly code: string | null;
  readonly detail: string | null;

  constructor(path: string, status: number, code: string | null, detail: string | null) {
    super(`board api ${path} → ${status}${detail !== null ? `: ${detail}` : ''}`);
    this.name = 'BoardApiError';
    this.path = path;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
