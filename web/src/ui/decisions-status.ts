import type { DecisionStatusView } from '../lib/board-protocol.js';
import { mustGet } from './dom.js';

const REASONS: Readonly<Record<string, string>> = {
  credential_missing: 'No local OpenRouter credential is available.',
  credential_unsafe: 'The credential store permissions, owner, or file type are unsafe.',
  credential_invalid: 'The resolved credential is empty or malformed.',
  config_invalid: 'The decision section of config.toml is invalid.',
  endpoint_untrusted: 'The configured endpoint is not the trusted OpenRouter HTTPS decisions endpoint.',
  auth_rejected: 'OpenRouter rejected the credential.',
  forbidden: 'OpenRouter refused access to the decisions model.',
  timeout: 'The bounded provider check timed out.',
  network_error: 'The provider could not be reached.',
  malformed_response: 'The provider returned an invalid typed answer envelope.',
  provider_degraded: 'The provider is unavailable or degraded.',
  probe_failed: 'The provider check did not confirm healthy decision routing.',
  stale_generation: 'A result from an older configuration was discarded.',
};

const LABELS: Readonly<Record<DecisionStatusView['status'], string>> = {
  disabled: 'OFF',
  checking: 'CHECKING',
  ready: 'READY',
  degraded: 'FALLBACK',
};

export class DecisionStatusCard {
  private readonly stamp = mustGet<HTMLElement>('decisions-stamp');
  private readonly summary = mustGet<HTMLElement>('decisions-summary');
  private readonly meta = mustGet<HTMLElement>('decisions-meta');
  private readonly setup = mustGet<HTMLElement>('decisions-setup');
  private readonly recheck = mustGet<HTMLButtonElement>('decisions-recheck');
  private current: DecisionStatusView | null = null;
  private recheckPending = false;

  constructor(private readonly onRecheck: () => Promise<DecisionStatusView> | null) {
    this.recheck.addEventListener('click', () => {
      const pending = this.onRecheck();
      if (pending === null) return;
      const requestBasis = this.current;
      this.recheckPending = true;
      this.syncRecheckButton();
      void pending
        .then((status) => this.render(status))
        .catch(() => {
          // A failed HTTP reply is not versioned. Do not let it overwrite a
          // newer pushed state that arrived while the request was pending.
          if (this.current === requestBasis) {
            this.summary.textContent = 'Recheck could not be started. The current deterministic route remains safe.';
          }
        })
        .finally(() => {
          this.recheckPending = false;
          this.syncRecheckButton();
        });
    });
  }

  render(status: DecisionStatusView): void {
    // Board snapshots and explicit recheck replies race over separate
    // transports. Within one service incarnation, generation is the
    // server-owned ordering key; ACROSS incarnations generations are not
    // comparable at all, so a reply from any other incarnation is stale by
    // definition (a dead process cannot outrank the live pushed state).
    if (
      this.current !== null &&
      (status.incarnation !== this.current.incarnation || status.generation < this.current.generation)
    ) return;
    this.current = status;
    this.stamp.textContent = LABELS[status.status];
    this.stamp.dataset.state = status.status;
    this.summary.textContent = this.summaryFor(status);
    const credential = status.credentialPresent
      ? `${status.credentialSource} credential`
      : status.enabled ? 'credential unavailable' : 'credential not inspected';
    this.meta.textContent = `${status.model} · ${credential}${status.checkedAt === null ? '' : ` · checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}`;
    this.setup.hidden = status.status === 'ready';
    this.syncRecheckButton();
  }

  private syncRecheckButton(): void {
    this.recheck.textContent = this.recheckPending ? 'Checking…' : 'Recheck';
    this.recheck.hidden = this.current?.enabled !== true;
    this.recheck.disabled = this.recheckPending || this.current?.status === 'checking';
  }

  private summaryFor(status: DecisionStatusView): string {
    if (status.status === 'disabled') return 'Deterministic routing only. Jev makes zero requests.';
    if (status.status === 'checking') return 'Running one bounded synthetic provider check before routing.';
    if (status.status === 'ready') return 'Jev triage is active; product safeguards remain authoritative.';
    return `${status.reason === null ? 'Provider unavailable.' : REASONS[status.reason] ?? status.reason} Deterministic fallback is active.`;
  }
}
