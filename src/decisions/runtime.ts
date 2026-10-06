import { randomUUID } from 'node:crypto';
import { unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import {
  configPathFor,
  loadConfig,
  DEFAULT_DECISION_PROFILE,
  effectiveDecisionProviders,
  type DecisionsConfig,
  type GruCommandConfig,
} from '../config.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { resolveCredential, type CredentialSource } from './credentials.js';
import { ProfileDecisionService, ProfileProvider } from './provider.js';
import type { DecisionProviderProfile } from './profile.js';
import { KEYLESS_CREDENTIAL, validateProviderProfile } from './profile.js';
import { deterministicOutcome, DeterministicDecisionService } from './service.js';
import type {
  DecisionFailureReason,
  DecisionOutcome,
  DecisionRequest,
  DecisionService,
  DecisionSurface,
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
  /** Test seam: delay before the one bounded automatic recheck after a
   * transient degradation (default 5000 ms). */
  readonly transientRecoveryMs?: number;
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

/** The default profile's identity fields, for status surfaces that predate
 * per-profile routing. An invalid merged table falls back to the legacy
 * `[decisions.jev]` fields rather than throwing out of a status path. */
function primaryProfileFields(config: DecisionsConfig): { model: string; endpoint: string } {
  try {
    const profile = effectiveDecisionProviders(config)[DEFAULT_DECISION_PROFILE];
    if (profile !== undefined) return { model: profile.model, endpoint: profile.endpoint };
  } catch {
    // fall through to the legacy fields
  }
  return { model: config.jev.model, endpoint: config.jev.endpoint };
}

function credentialFailureReason(state: 'absent' | 'invalid' | 'unsafe' | 'unreadable'): DecisionFailureReason {
  return state === 'absent'
    ? 'credential_missing'
    : state === 'invalid'
      ? 'credential_invalid'
      : 'credential_unsafe';
}

/** A resolution that reports `present` always carries a key; reaching the
 * failure mapper with one is a broken caller, not a fallback case. */
function resolvedCredentialReason(credential: { readonly state: string; readonly key?: string }): DecisionFailureReason {
  if (credential.state === 'present' && credential.key !== undefined) {
    throw new Error('credential resolution reported present with a key; this is a caller bug');
  }
  return credentialFailureReason(credential.state as 'absent' | 'invalid' | 'unsafe' | 'unreadable');
}

/**
 * Hot-reloadable decision-service owner over provider profiles (issue #222).
 *
 * One generation owns one provider service per profile; the DEFAULT profile
 * (`openrouter-jev`) is probed at startup and owns the runtime health
 * status/degrade/incident semantics exactly as the single-provider runtime
 * did. Every other profile is constructed offline: a profile whose
 * credential cannot resolve stands in deterministically per call and never
 * invents an owner incident — nobody may be routed to it. `decide` routes
 * surface → profile via `[decisions.surfaces]`; an omitted surface routes
 * to the default profile, which is today's behavior unchanged. A
 * generation changes before old providers are disposed, so a late answer
 * can never alter caller state.
 */
export class DecisionRuntime implements DecisionService {
  private readonly options: DecisionRuntimeOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly log: Log;
  private readonly configFile: string;
  private currentConfig: DecisionsConfig;
  private service: DecisionService;
  /** The live default-profile service; null while the default profile is
   * degraded/disabled (its map entry is then a deterministic stand-in). */
  private primary: ProfileDecisionService | null = null;
  private pendingPrimary: ProfileDecisionService | null = null;
  private readonly profileServices = new Map<string, DecisionService>();
  private readonly incarnation = randomUUID();
  private generation = 0;
  private disposed = false;
  private watching = false;
  private eventWatcher: FSWatcher | null = null;
  private recheckInFlight: Promise<DecisionRuntimeStatus> | null = null;
  private recheckTrailing = false;
  /** One bounded automatic recheck per transient degradation incident; a
   * still-down provider then waits for a human recheck or a config change
   * (no unbounded retry/poll/spend loop). Re-armed by every ready/disable. */
  private transientRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRecheckArmed = true;
  private currentStatus: DecisionRuntimeStatus;

  constructor(initial: DecisionsConfig, options: DecisionRuntimeOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.log = options.log ?? (() => {});
    this.configFile = configPathFor(options.instanceDir);
    this.currentConfig = initial;
    this.service = new DeterministicDecisionService(thresholdsOf(initial), 'disabled');
    const fields = primaryProfileFields(initial);
    this.currentStatus = {
      enabled: initial.jev.enabled,
      status: initial.jev.enabled ? 'checking' : 'disabled',
      reason: initial.jev.enabled ? null : 'disabled',
      model: fields.model,
      endpoint: fields.endpoint,
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
      this.disposeServices();
      this.currentConfig = next;
      const fields = primaryProfileFields(next);
      this.service = new DeterministicDecisionService(thresholdsOf(next), 'provider_degraded');
      this.currentStatus = {
        enabled: true,
        status: 'checking',
        reason: null,
        model: fields.model,
        endpoint: fields.endpoint,
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

  /** Which configured profile answers this surface (issue #222): an
   * omitted or unrouted surface rides the default profile. */
  private routeFor(surface: string | undefined): string {
    if (surface === undefined) return DEFAULT_DECISION_PROFILE;
    const routed = this.currentConfig.surfaces[surface];
    return routed ?? DEFAULT_DECISION_PROFILE;
  }

  /** True when the profile this surface routes to is LIVE (constructed and
   * probed), so callers can gate work on the routed profile's health
   * instead of the default profile's. The runtime-level disabled state
   * gates everything; a degraded default only gates default-routed
   * surfaces. */
  readyFor(surface?: string): boolean {
    if (this.disposed || !this.currentConfig.jev.enabled) return false;
    if (this.currentStatus.status === 'checking') return false;
    const name = this.routeFor(surface);
    if (name === DEFAULT_DECISION_PROFILE) return this.primary !== null;
    return this.profileServices.get(name) instanceof ProfileDecisionService;
  }

  async decide<Q extends QuestionSet>(
    request: DecisionRequest<Q>,
    opts?: DecisionSurface,
  ): Promise<DecisionOutcome<Q>> {
    if (this.disposed) return deterministicOutcome(request, thresholdsOf(this.currentConfig), 'disposed');
    const profileName = this.routeFor(opts?.surface);
    const generation = this.generation;
    const selected = this.profileServices.get(profileName) ?? this.service;
    const outcome = await selected.decide(request, opts);
    if (this.disposed || generation !== this.generation || selected !== (this.profileServices.get(profileName) ?? this.service)) {
      return deterministicOutcome(request, thresholdsOf(this.currentConfig), 'stale_generation');
    }
    // A live default-profile call failing degrades the runtime (existing
    // semantics — one health, one incident stream). Failures of any other
    // profile fall back deterministically per call, are logged for the
    // operator, and never invent an owner incident for a surface nobody
    // may be watching. Durable per-profile counters arrive with the yield
    // telemetry (#214).
    if (outcome.provenance.source === 'deterministic') {
      if (profileName === DEFAULT_DECISION_PROFILE && this.primary !== null) {
        const reason = outcome.provenance.fallbackReason ?? 'provider_degraded';
        if (reason !== 'capacity_limited') this.degrade(reason);
        return deterministicOutcome(request, thresholdsOf(this.currentConfig), reason);
      }
      if (profileName !== DEFAULT_DECISION_PROFILE) {
        this.log('warn', 'decision profile fell back; deterministic answer served', {
          profile: profileName,
          reason: outcome.provenance.fallbackReason ?? 'provider_degraded',
        });
      }
    }
    return outcome;
  }

  /** Dispose every generation-owned service (idempotent per service;
   * deterministic stand-ins carry nothing to dispose). */
  private disposeServices(): void {
    this.pendingPrimary?.dispose();
    this.pendingPrimary = null;
    this.primary?.dispose();
    this.primary = null;
    for (const service of this.profileServices.values()) {
      if (service instanceof ProfileDecisionService) service.dispose();
    }
    this.profileServices.clear();
  }

  /** Build one non-default profile's service OFFLINE: no probe, no owner
   * incident. A profile that cannot be constructed stands in
   * deterministically with the honest reason. */
  private buildProfileService(name: string, profile: DecisionProviderProfile): DecisionService {
    const thresholds = thresholdsOf(this.currentConfig);
    const standIn = (reason: DecisionFailureReason): DecisionService =>
      new DeterministicDecisionService(thresholds, reason);
    try {
      validateProviderProfile(profile, `decisions.providers.${name}`);
    } catch {
      return standIn('config_invalid');
    }
    if (profile.credential !== KEYLESS_CREDENTIAL) {
      const credential = resolveCredential(this.options.instanceDir, this.env, profile.credential);
      if (credential.state !== 'present' || credential.key === undefined) {
        return standIn(resolvedCredentialReason(credential));
      }
      try {
        return new ProfileDecisionService(
          new ProfileProvider({
            profile,
            key: credential.key,
            credentialMode: 'resolved',
            fetchImpl: this.options.fetchImpl,
          }),
          thresholds,
          name,
        );
      } catch (error) {
        return standIn(providerConstructionReason(error));
      }
    }
    try {
      return new ProfileDecisionService(
        new ProfileProvider({ profile, key: null, credentialMode: 'resolved', fetchImpl: this.options.fetchImpl }),
        thresholds,
        name,
      );
    } catch (error) {
      return standIn(providerConstructionReason(error));
    }
  }

  private async configure(config: DecisionsConfig, initial: boolean): Promise<DecisionRuntimeStatus> {
    if (this.disposed) return this.status();
    const previous = this.currentStatus.status;
    this.generation += 1;
    this.disposeServices();
    this.currentConfig = config;
    const fields = primaryProfileFields(config);
    this.service = new DeterministicDecisionService(
      thresholdsOf(config),
      config.jev.enabled ? 'provider_degraded' : 'disabled',
    );
    if (!config.jev.enabled) {
      this.currentStatus = this.disabledStatusOf('disabled', new Date().toISOString());
      this.signalStatus();
      const resolved = this.resolveDegradedIncidents();
      if ((!initial && previous !== 'disabled') || resolved > 0) this.postResolved('disabled');
      this.autoRecheckArmed = true;
      return this.status();
    }

    let effective: Record<string, DecisionProviderProfile>;
    try {
      effective = effectiveDecisionProviders(config);
      for (const [name, profile] of Object.entries(effective)) {
        validateProviderProfile(profile, `decisions.providers.${name}`);
      }
    } catch {
      return this.degrade('config_invalid');
    }
    this.currentStatus = {
      enabled: true,
      status: 'checking',
      reason: null,
      model: fields.model,
      endpoint: fields.endpoint,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: this.incarnation,
      generation: this.generation,
    };
    this.signalStatus();
    const generation = this.generation;
    // Non-default profiles: offline construction only (see
    // buildProfileService). Their health is per-call honest fallback plus
    // `check --profile`, never a startup owner incident.
    for (const [name, profile] of Object.entries(effective)) {
      if (name !== DEFAULT_DECISION_PROFILE) this.profileServices.set(name, this.buildProfileService(name, profile));
    }
    const primaryProfile = effective[DEFAULT_DECISION_PROFILE];
    if (primaryProfile === undefined) return this.degrade('config_invalid');
    // A keyless default-profile override (loopback systemone) never
    // resolves a credential: the provider runs with no key, exactly like
    // the non-default builder.
    let key: string | null = null;
    let credentialSource: CredentialSource = 'none';
    if (primaryProfile.credential !== KEYLESS_CREDENTIAL) {
      const credential = resolveCredential(this.options.instanceDir, this.env, primaryProfile.credential);
      if (credential.state !== 'present' || credential.key === undefined) {
        const reason = resolvedCredentialReason(credential);
        return this.degrade(reason, credential.source);
      }
      key = credential.key;
      credentialSource = credential.source;
    }

    let candidate: ProfileDecisionService;
    try {
      candidate = new ProfileDecisionService(
        new ProfileProvider({
          profile: primaryProfile,
          key,
          credentialMode: 'resolved',
          fetchImpl: this.options.fetchImpl,
        }),
        thresholdsOf(config),
        DEFAULT_DECISION_PROFILE,
      );
    } catch (error) {
      return this.degrade(providerConstructionReason(error), credentialSource);
    }
    this.pendingPrimary = candidate;
    const probe = await candidate.decide(PROBE_REQUEST);
    if (this.pendingPrimary === candidate) this.pendingPrimary = null;
    if (this.disposed || generation !== this.generation) {
      candidate.dispose();
      return this.status();
    }
    if (probe.provenance.source !== 'jev') {
      candidate.dispose();
      return this.degrade(probe.provenance.fallbackReason ?? 'provider_degraded', credentialSource);
    }
    // This is a semantic liveness check, not an operator action. User
    // routing/confirmation thresholds must not make a healthy provider
    // impossible to start, so inspect the strictly validated raw answers.
    if (
      probe.answers.provider_alive.noul < 0.5 ||
      probe.answers.probe_class.choice !== 'healthy_probe'
    ) {
      candidate.dispose();
      return this.degrade('probe_failed', credentialSource);
    }
    this.profileServices.set(DEFAULT_DECISION_PROFILE, candidate);
    this.primary = candidate;
    this.service = candidate;
    this.currentStatus = {
      enabled: true,
      status: 'ready',
      reason: null,
      model: probe.provenance.model ?? primaryProfile.model,
      endpoint: primaryProfile.endpoint,
      credentialPresent: credentialSource !== 'none',
      credentialSource,
      checkedAt: new Date().toISOString(),
      incarnation: this.incarnation,
      generation: this.generation,
    };
    this.log('info', 'Jev decision service ready', {
      model: this.currentStatus.model,
      profile: DEFAULT_DECISION_PROFILE,
      profiles: [...this.profileServices.keys()].sort(),
      credential_source: credentialSource,
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
    this.autoRecheckArmed = true;
    return this.status();
  }

  /** Retire ONLY the default profile's provider: a degrade is the default
   * profile's health event, not a configuration change, so healthy
   * non-default profiles keep serving their routed surfaces. (A config
   * change goes through configure(), which disposes everything and bumps
   * the generation — that path keeps the discard-in-flight semantics.) */
  private degradeDefaultService(reason: DecisionFailureReason): void {
    this.pendingPrimary?.dispose();
    this.pendingPrimary = null;
    this.primary?.dispose();
    this.primary = null;
    const standIn = new DeterministicDecisionService(thresholdsOf(this.currentConfig), reason);
    this.profileServices.set(DEFAULT_DECISION_PROFILE, standIn);
  }

  private degrade(
    reason: DecisionFailureReason,
    credentialSource: CredentialSource = this.currentStatus.credentialSource,
  ): DecisionRuntimeStatus {
    this.generation += 1;
    this.degradeDefaultService(reason);
    this.service = this.profileServices.get(DEFAULT_DECISION_PROFILE)!;
    const fields = primaryProfileFields(this.currentConfig);
    this.currentStatus = {
      enabled: true,
      status: 'degraded',
      reason,
      model: fields.model,
      endpoint: fields.endpoint,
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
      // Owner-only remediation (provider credentials/quota), so this is
      // human-facing: FOR YOU + bell, never a machine wake.
      routing: 'needs-owner',
      severity: 'error',
      title: 'Jev degraded — deterministic fallback active',
      detail: `${reason}. Run the local credentials command if needed, then use Recheck; Gru Command remains usable.`,
      // Acknowledgement records that a human saw the incident; it does not
      // resolve the still-degraded system state. Keep one active row until
      // recovery/disable resolves it, then allow a later recurrence.
      dedupe: 'active',
    }));
    if (reason === 'timeout' || reason === 'network_error' || reason === 'provider_degraded') {
      this.scheduleTransientRecovery();
    }
    return this.status();
  }

  /** One bounded automatic recheck per transient degradation incident: a
   * single provider blip heals without operator action, and a second
   * consecutive failure consumes the arm so no retry/poll/spend loop can
   * form. Re-arm happens on every recovery (ready) or disable. */
  private scheduleTransientRecovery(): void {
    if (this.disposed || !this.autoRecheckArmed || this.transientRecoveryTimer !== null) return;
    this.autoRecheckArmed = false;
    this.transientRecoveryTimer = setTimeout(() => {
      this.transientRecoveryTimer = null;
      if (this.disposed) return;
      this.log('info', 'transient degradation — performing the one bounded automatic recheck', {});
      void this.recheck();
    }, this.options.transientRecoveryMs ?? 5_000);
    this.transientRecoveryTimer.unref?.();
  }

  /** The single shape for "Jev off": zero credential claims, one reason. */
  private disabledStatusOf(reason: DecisionFailureReason, checkedAt: string | null): DecisionRuntimeStatus {
    const fields = primaryProfileFields(this.currentConfig);
    return {
      enabled: false,
      status: 'disabled',
      reason,
      model: fields.model,
      endpoint: fields.endpoint,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt,
      incarnation: this.incarnation,
      generation: this.generation,
    };
  }

  private degradeInvalidConfig(): DecisionRuntimeStatus {
    if (!this.currentConfig.jev.enabled) {
      // A Jev-OFF instance stays off: an unrelated config.toml typo must not
      // enable the feature or invent an operator incident. The
      // last-known-good thresholds keep deterministic routing intact.
      this.currentStatus = this.disabledStatusOf('config_invalid', new Date().toISOString());
      this.signalStatus();
      return this.status();
    }
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
    if (this.transientRecoveryTimer !== null) {
      clearTimeout(this.transientRecoveryTimer);
      this.transientRecoveryTimer = null;
    }
    this.disposeServices();
    this.service = new DeterministicDecisionService(thresholdsOf(this.currentConfig), 'disposed');
    if (this.watching) {
      unwatchFile(this.configFile);
      this.eventWatcher?.close();
      this.eventWatcher = null;
      this.watching = false;
    }
  }
}

function providerConstructionReason(error: unknown): DecisionFailureReason {
  return typeof error === 'object' && error !== null && 'reason' in error
    ? (error as { reason: DecisionFailureReason }).reason
    : 'provider_degraded';
}

export interface DecisionProfileCheckResult {
  readonly profile: string;
  readonly ok: boolean;
  readonly status: 'ready' | 'degraded' | 'disabled';
  readonly reason: DecisionFailureReason | null;
  readonly model: string | null;
}

/**
 * Probe any single configured profile (CLI `check --profile <name>`): the
 * same synthetic probe and semantic liveness check as the runtime's
 * startup, scoped to one profile, with no runtime, no watcher and no
 * owner incidents.
 */
export async function checkDecisionProfile(
  config: DecisionsConfig,
  profileName: string,
  options: Pick<DecisionRuntimeOptions, 'instanceDir' | 'env' | 'fetchImpl'>,
): Promise<DecisionProfileCheckResult> {
  if (!config.jev.enabled) {
    // Even with the master switch off, an unknown profile is an operator
    // typo and must fail loudly — never report a successful check.
    const effective = effectiveDecisionProviders(config);
    if (!Object.prototype.hasOwnProperty.call(effective, profileName)) {
      throw new Error(`unknown decision profile "${profileName}" (available: ${Object.keys(effective).join(', ')})`);
    }
    return { profile: profileName, ok: true, status: 'disabled', reason: null, model: null };
  }
  let profile: DecisionProviderProfile;
  try {
    const effective = effectiveDecisionProviders(config);
    const found = effective[profileName];
    if (found === undefined || !Object.prototype.hasOwnProperty.call(effective, profileName)) {
      throw new Error(`unknown decision profile "${profileName}" (available: ${Object.keys(effective).join(', ')})`);
    }
    validateProviderProfile(found, `decisions.providers.${profileName}`);
    profile = found;
  } catch (error) {
    if (error instanceof Error && /unknown decision profile/.test(error.message)) throw error;
    return { profile: profileName, ok: false, status: 'degraded', reason: 'config_invalid', model: null };
  }
  let key: string | null = null;
  if (profile.credential !== KEYLESS_CREDENTIAL) {
    const credential = resolveCredential(options.instanceDir, options.env ?? process.env, profile.credential);
    if (credential.state !== 'present' || credential.key === undefined) {
      return {
        profile: profileName,
        ok: false,
        status: 'degraded',
        reason: resolvedCredentialReason(credential),
        model: null,
      };
    }
    key = credential.key;
  }
  let service: ProfileDecisionService;
  try {
    service = new ProfileDecisionService(
      new ProfileProvider({ profile, key, credentialMode: 'resolved', fetchImpl: options.fetchImpl }),
      config.thresholds,
      profileName,
    );
  } catch (error) {
    return { profile: profileName, ok: false, status: 'degraded', reason: providerConstructionReason(error), model: null };
  }
  try {
    const probe = await service.decide(PROBE_REQUEST);
    if (probe.provenance.source !== 'jev') {
      return { profile: profileName, ok: false, status: 'degraded', reason: probe.provenance.fallbackReason ?? 'provider_degraded', model: null };
    }
    if (probe.answers.provider_alive.noul < 0.5 || probe.answers.probe_class.choice !== 'healthy_probe') {
      return { profile: profileName, ok: false, status: 'degraded', reason: 'probe_failed', model: null };
    }
    return { profile: profileName, ok: true, status: 'ready', reason: null, model: probe.provenance.model ?? profile.model };
  } finally {
    service.dispose();
  }
}
