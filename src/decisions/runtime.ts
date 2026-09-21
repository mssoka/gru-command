import { randomUUID } from 'node:crypto';
import { unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import {
  configPathFor,
  loadConfig,
  type DecisionsConfig,
  type GruCommandConfig,
} from '../config.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { resolveCredential, type CredentialSource } from './credentials.js';
import { JevDecisionService, JevProvider } from './provider.js';
import { deterministicOutcome, DeterministicDecisionService } from './service.js';
import type {
  DecisionFailureReason,
  DecisionOutcome,
  DecisionRequest,
  DecisionService,
  QuestionSet,
  ThresholdsConfig,
} from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export type DecisionHealthState = 'disabled' | 'checking' | 'ready' | 'degraded';

export interface DecisionRuntimeStatus {
  readonly enabled: boolean;
  readonly status: DecisionHealthState;
  readonly reason: DecisionFailureReason | null;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialPresent: boolean;
  readonly credentialSource: CredentialSource;
  readonly checkedAt: string | null;
  /** Unique to this service process; generations are ordered only inside it. */
  readonly incarnation: string;
  readonly generation: number;
}

export interface DecisionRuntimeOptions {
  readonly instanceDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly notifications?: NotificationCenter;
  readonly log?: Log;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly watchConfig?: boolean;
  readonly loadConfig?: (env: NodeJS.ProcessEnv, home: string) => GruCommandConfig;
  /** Durable/status-bus projection; failures are isolated from routing. */
  readonly onStatusChange?: (status: DecisionRuntimeStatus) => void;
}

const PROBE_QUESTIONS = {
  provider_alive: {
    type: 'noul',
    instructions: 'Did the decision provider receive and answer this synthetic health check?',
    criteria: { true: 'The provider returned this answer.', false: 'The provider did not return a valid answer.' },
  },
  probe_class: {
    type: 'choice',
    instructions: 'Classify this synthetic state.',
    options: ['healthy_probe', 'other'] as const,
    criteria: {
      healthy_probe: 'The state explicitly says it is a synthetic Gru Command startup health check.',
      other: 'The state describes anything else.',
    },
  },
} as const;

const PROBE_REQUEST: DecisionRequest<typeof PROBE_QUESTIONS> = {
  state: 'Synthetic Gru Command Jev startup health check; no user or project data is included.',
  questions: PROBE_QUESTIONS,
  risks: { provider_alive: 'read_only', probe_class: 'read_only' },
  fallback: {
    provider_alive: { type: 'noul', noul: 0 },
    probe_class: {
      type: 'choice',
      choice: 'other',
      probabilities: { healthy_probe: 0, other: 1 },
      confidence: 1,
    },
  },
};

function thresholdsOf(config: DecisionsConfig): ThresholdsConfig {
  return config.thresholds;
}

/**
 * Hot-reloadable decision-service owner. A generation changes before the
 * old provider is disposed, so a late answer can never alter caller state.
 */
export class DecisionRuntime implements DecisionService {
  private readonly options: DecisionRuntimeOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly log: Log;
  private readonly configFile: string;
  private currentConfig: DecisionsConfig;
  private service: DecisionService;
  private jev: JevDecisionService | null = null;
  private pendingJev: JevDecisionService | null = null;
  private readonly incarnation = randomUUID();
  private generation = 0;
  private disposed = false;
  private watching = false;
  private eventWatcher: FSWatcher | null = null;
  private recheckInFlight: Promise<DecisionRuntimeStatus> | null = null;
  private recheckTrailing = false;
  private currentStatus: DecisionRuntimeStatus;

  constructor(initial: DecisionsConfig, options: DecisionRuntimeOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.log = options.log ?? (() => {});
    this.configFile = configPathFor(options.instanceDir);
    this.currentConfig = initial;
    this.service = new DeterministicDecisionService(thresholdsOf(initial), 'disabled');
    this.currentStatus = {
      enabled: initial.jev.enabled,
      status: initial.jev.enabled ? 'checking' : 'disabled',
      reason: initial.jev.enabled ? null : 'disabled',
      model: initial.jev.model,
      endpoint: initial.jev.endpoint,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: this.incarnation,
      generation: this.generation,
    };
  }

  start(): Promise<DecisionRuntimeStatus> {
    // Install the watcher before the bounded startup probe. A config write
    // during that probe then queues one trailing disk read instead of being
    // lost in the old configure-then-watch gap.
    if (this.options.watchConfig !== false && !this.watching) {
      this.watching = true;
      // Two complementary watchers: fs.watch is immediate (event-based)
      // but can miss atomic replaces on some filesystems; watchFile polls
      // and only lags by its interval. Redundant rechecks are coalesced
      // by the in-flight/trailing probe logic, so both may fire safely.
      watchFile(this.configFile, { interval: 500, persistent: false }, () => {
        void this.reloadFromDiskIfChanged();
      });
      try {
        this.eventWatcher = watch(this.configFile, () => {
          void this.reloadFromDiskIfChanged();
        });
        this.eventWatcher.on('error', () => {
          this.eventWatcher?.close();
          this.eventWatcher = null;
        });
      } catch {
        // Polling watcher alone remains authoritative.
      }
    }
    const initial = this.currentConfig;
    return this.beginChecks(() => this.configure(initial, true));
  }

  status(): DecisionRuntimeStatus {
    return { ...this.currentStatus };
  }

  recheck(): Promise<DecisionRuntimeStatus> {
    return this.beginChecks(() => this.configureFromDisk());
  }

  private reloadFromDiskIfChanged(): Promise<DecisionRuntimeStatus> {
    if (this.disposed) return Promise.resolve(this.status());
    try {
      const next = (this.options.loadConfig ?? loadConfig)(this.env, this.home).decisions;
      if (JSON.stringify(next) === JSON.stringify(this.currentConfig)) return Promise.resolve(this.status());
      return this.beginChecks(() => this.configure(next, false));
    } catch {
      return Promise.resolve(this.degradeInvalidConfig());
    }
  }

  private beginChecks(first: () => Promise<DecisionRuntimeStatus>): Promise<DecisionRuntimeStatus> {
    if (this.recheckInFlight !== null) {
      // Apply a changed/invalid configuration's generation invalidation now,
      // not after the remote probe queue drains. The trailing pass still
      // owns the next probe, so paid work remains serialized and bounded.
      this.observeQueuedConfiguration();
      this.recheckTrailing = true;
      return this.recheckInFlight;
    }
    const operation = (async () => {
      let status: DecisionRuntimeStatus;
      let run = first;
      do {
        // Clear before each bounded probe. A recheck arriving during this
        // pass sets the bit again and therefore cannot be lost, including
        // while a prior trailing pass is running. Every trailing pass reads
        // disk; only the first startup pass may use the boot-loaded config.
        this.recheckTrailing = false;
        status = await run();
        run = () => this.configureFromDisk();
      } while (this.recheckTrailing && !this.disposed);
      return status;
    })().finally(() => {
      if (this.recheckInFlight === operation) this.recheckInFlight = null;
      this.recheckTrailing = false;
    });
    this.recheckInFlight = operation;
    return operation;
  }

  private async configureFromDisk(): Promise<DecisionRuntimeStatus> {
    if (this.disposed) return this.status();
    try {
      const config = (this.options.loadConfig ?? loadConfig)(this.env, this.home);
      return await this.configure(config.decisions, false);
    } catch {
      return this.degradeInvalidConfig();
    }
  }

  private observeQueuedConfiguration(): void {
    if (this.disposed) return;
    try {
      const next = (this.options.loadConfig ?? loadConfig)(this.env, this.home).decisions;
      if (JSON.stringify(next) === JSON.stringify(this.currentConfig)) return;
      if (!next.jev.enabled) {
        // The disabled configure branch is synchronous (no provider await).
        void this.configure(next, false);
        return;
      }
      this.generation += 1;
      this.pendingJev?.dispose();
      this.pendingJev = null;
      this.jev?.dispose();
      this.jev = null;
      this.currentConfig = next;
      this.service = new DeterministicDecisionService(thresholdsOf(next), 'provider_degraded');
      this.currentStatus = {
        enabled: true,
        status: 'checking',
        reason: null,
        model: next.jev.model,
        endpoint: next.jev.endpoint,
        credentialPresent: false,
        credentialSource: 'none',
        checkedAt: null,
        incarnation: this.incarnation,
        generation: this.generation,
      };
      this.signalStatus();
    } catch {
      this.degradeInvalidConfig();
    }
  }

  async decide<Q extends QuestionSet>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
    if (this.disposed) return deterministicOutcome(request, thresholdsOf(this.currentConfig), 'disposed');
    const generation = this.generation;
    const selected = this.service;
    const outcome = await selected.decide(request);
    if (this.disposed || generation !== this.generation || selected !== this.service) {
      return deterministicOutcome(request, thresholdsOf(this.currentConfig), 'stale_generation');
    }
    if (outcome.provenance.source === 'deterministic' && this.jev !== null) {
      const reason = outcome.provenance.fallbackReason ?? 'provider_degraded';
      if (reason !== 'capacity_limited') this.degrade(reason);
      return deterministicOutcome(request, thresholdsOf(this.currentConfig), reason);
    }
    return outcome;
  }

  private async configure(config: DecisionsConfig, initial: boolean): Promise<DecisionRuntimeStatus> {
    if (this.disposed) return this.status();
    const previous = this.currentStatus.status;
    this.generation += 1;
    this.pendingJev?.dispose();
    this.pendingJev = null;
    this.jev?.dispose();
    this.jev = null;
    this.currentConfig = config;
    this.service = new DeterministicDecisionService(
      thresholdsOf(config),
      config.jev.enabled ? 'provider_degraded' : 'disabled',
    );
    if (!config.jev.enabled) {
      this.currentStatus = {
        enabled: false,
        status: 'disabled',
        reason: 'disabled',
        model: config.jev.model,
        endpoint: config.jev.endpoint,
        credentialPresent: false,
        credentialSource: 'none',
        checkedAt: new Date().toISOString(),
        incarnation: this.incarnation,
        generation: this.generation,
      };
      this.signalStatus();
      const resolved = this.resolveDegradedIncidents();
      if ((!initial && previous !== 'disabled') || resolved > 0) this.postResolved('disabled');
      return this.status();
    }

    this.currentStatus = {
      enabled: true,
      status: 'checking',
      reason: null,
      model: config.jev.model,
      endpoint: config.jev.endpoint,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: this.incarnation,
      generation: this.generation,
    };
    this.signalStatus();
    const generation = this.generation;
    const credential = resolveCredential(this.options.instanceDir, this.env);
    if (credential.state !== 'present' || credential.key === undefined) {
      const reason: DecisionFailureReason =
        credential.state === 'absent'
          ? 'credential_missing'
          : credential.state === 'invalid'
            ? 'credential_invalid'
            : 'credential_unsafe';
      return this.degrade(reason, credential.source);
    }

    let candidate: JevDecisionService;
    try {
      candidate = new JevDecisionService(
        new JevProvider({
          config: config.jev,
          key: credential.key,
          credentialMode: 'resolved',
          fetchImpl: this.options.fetchImpl,
        }),
        thresholdsOf(config),
      );
    } catch (error) {
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error
          ? (error as { reason: DecisionFailureReason }).reason
          : 'provider_degraded';
      return this.degrade(reason, credential.source);
    }
    this.pendingJev = candidate;
    const probe = await candidate.decide(PROBE_REQUEST);
    if (this.pendingJev === candidate) this.pendingJev = null;
    if (this.disposed || generation !== this.generation) {
      candidate.dispose();
      return this.status();
    }
    if (probe.provenance.source !== 'jev') {
      candidate.dispose();
      return this.degrade(probe.provenance.fallbackReason ?? 'provider_degraded', credential.source);
    }
    // This is a semantic liveness check, not an operator action. User
    // routing/confirmation thresholds must not make a healthy provider
    // impossible to start, so inspect the strictly validated raw answers.
    if (
      probe.answers.provider_alive.noul < 0.5 ||
      probe.answers.probe_class.choice !== 'healthy_probe'
    ) {
      candidate.dispose();
      return this.degrade('probe_failed', credential.source);
    }
    this.jev = candidate;
    this.service = candidate;
    this.currentStatus = {
      enabled: true,
      status: 'ready',
      reason: null,
      model: probe.provenance.model ?? config.jev.model,
      endpoint: config.jev.endpoint,
      credentialPresent: true,
      credentialSource: credential.source,
      checkedAt: new Date().toISOString(),
      incarnation: this.incarnation,
      generation: this.generation,
    };
    this.log('info', 'Jev decision service ready', {
      model: this.currentStatus.model,
      credential_source: credential.source,
      latency_ms: probe.provenance.latencyMs,
      usage: probe.provenance.usage,
    });
    this.signalStatus();
    const resolved = this.resolveDegradedIncidents();
    if (previous === 'degraded' || resolved > 0) this.postResolved('ready');
    else this.notificationEffect('ready notification', () => this.options.notifications?.postIncident({
      kind: 'decisions.ready',
      routing: 'fyi',
      severity: 'info',
      title: 'Jev decision routing ready',
      detail: `Startup check passed; model ${this.currentStatus.model}.`,
      dedupe: 'all',
    }));
    return this.status();
  }

  private degrade(
    reason: DecisionFailureReason,
    credentialSource: CredentialSource = this.currentStatus.credentialSource,
  ): DecisionRuntimeStatus {
    this.generation += 1;
    this.pendingJev?.dispose();
    this.pendingJev = null;
    this.jev?.dispose();
    this.jev = null;
    this.service = new DeterministicDecisionService(thresholdsOf(this.currentConfig), reason);
    this.currentStatus = {
      enabled: true,
      status: 'degraded',
      reason,
      model: this.currentConfig.jev.model,
      endpoint: this.currentConfig.jev.endpoint,
      credentialPresent: credentialSource !== 'none' && !reason.startsWith('credential_'),
      credentialSource,
      checkedAt: new Date().toISOString(),
      incarnation: this.incarnation,
      generation: this.generation,
    };
    this.log('warn', 'Jev decision service degraded; deterministic fallback active', { reason });
    this.signalStatus();
    this.notificationEffect('degraded notification', () => this.options.notifications?.postIncident({
      kind: `decisions.degraded.${reason}`,
      routing: 'action-required',
      severity: 'error',
      title: 'Jev degraded — deterministic fallback active',
      detail: `${reason}. Run the local credentials command if needed, then use Recheck; Gru Command remains usable.`,
      // Acknowledgement records that a human saw the incident; it does not
      // resolve the still-degraded system state. Keep one active row until
      // recovery/disable resolves it, then allow a later recurrence.
      dedupe: 'active',
    }));
    return this.status();
  }

  private degradeInvalidConfig(): DecisionRuntimeStatus {
    this.currentConfig = { ...this.currentConfig, jev: { ...this.currentConfig.jev, enabled: true } };
    return this.degrade('config_invalid');
  }

  private postResolved(state: 'ready' | 'disabled'): void {
    this.notificationEffect(`${state} notification`, () => this.options.notifications?.post({
      kind: state === 'ready' ? 'decisions.recovered' : 'decisions.disabled',
      routing: 'fyi',
      severity: 'info',
      title: state === 'ready' ? 'Jev decision routing recovered' : 'Jev decision routing disabled',
      detail: state === 'ready' ? 'Startup check passed; Jev routes are active again.' : 'Deterministic routing is active; no new Jev requests will start.',
    }));
  }

  private resolveDegradedIncidents(): number {
    let count = 0;
    this.notificationEffect('incident resolution', () => {
      count = this.options.notifications?.resolveIncidents('decisions.degraded.', 'decisions-runtime').length ?? 0;
    });
    return count;
  }

  private notificationEffect(label: string, effect: () => unknown): void {
    try {
      effect();
    } catch (error) {
      this.log('error', `Jev ${label} failed; routing state remains usable`, { error: String(error) });
    }
  }

  private signalStatus(): void {
    try {
      this.options.onStatusChange?.(this.status());
    } catch (error) {
      this.log('error', 'Jev status event failed; routing state remains usable', { error: String(error) });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pendingJev?.dispose();
    this.pendingJev = null;
    this.jev?.dispose();
    this.jev = null;
    this.service = new DeterministicDecisionService(thresholdsOf(this.currentConfig), 'disposed');
    if (this.watching) {
      unwatchFile(this.configFile);
      this.eventWatcher?.close();
      this.eventWatcher = null;
      this.watching = false;
    }
  }
}
