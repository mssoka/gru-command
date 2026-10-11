import type { Proposal, Plan, IntakeRequest, IntakeReadback } from '../../../src/intake/types.js';
export type { Proposal, Plan, IntakeRequest, IntakeReadback };
export interface ReviewDecision {
  readonly repoPath: string;
  readonly intakeId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly expectedToken: string | null;
}
export class IntakeClientError extends Error {
  constructor(readonly code: string, message: string, readonly readback?: IntakeReadback) { super(message); this.name = 'IntakeClientError'; }
}
export class IntakeClient {
  constructor(private readonly options: { readonly token: string; readonly host: string; readonly secure?: boolean; readonly timeoutMs?: number }) {}
  preview(request: IntakeRequest): Promise<Proposal> { return this.post('/preview', request); }
  revise(request: { readonly repoPath: string; readonly intakeId: string; readonly requestId: string; readonly previousRequestId: string; readonly revisionId: string; readonly plan: Plan }): Promise<Proposal> { return this.post('/revision', request); }
  review(request: ReviewDecision): Promise<IntakeReadback> { return this.post('/review', request); }
  reject(request: ReviewDecision): Promise<IntakeReadback> { return this.post('/reject', request); }
  approve(request: ReviewDecision & { readonly selected: readonly string[] }): Promise<IntakeReadback> { return this.post('/approve', request); }
  read(repoPath: string, intakeId: string, requestId: string): Promise<Proposal> { return this.request(`/${encodeURIComponent(intakeId)}/requests/${encodeURIComponent(requestId)}?${new URLSearchParams({ repoPath })}`); }
  diff(repoPath: string, intakeId: string, from: string, to: string): Promise<unknown> { return this.request(`/${encodeURIComponent(intakeId)}/diff?${new URLSearchParams({ repoPath, from, to })}`); }
  readback(repoPath: string, intakeId: string, token?: string): Promise<IntakeReadback> { return this.request(`/${encodeURIComponent(intakeId)}/review?${new URLSearchParams({ repoPath, ...(token === undefined ? {} : { token }) })}`); }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      const response = await fetch(`${this.options.secure === false ? 'http' : 'https'}://${this.options.host}/api/intake${path}`, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000), headers: { authorization: `Bearer ${this.options.token}`, ...init?.headers } });
      const body = await response.json() as T & { error?: string; detail?: string; readback?: IntakeReadback };
      if (!response.ok) throw new IntakeClientError(body.error ?? 'intake_failed', body.detail ?? `Intake failed (${response.status})`, body.readback);
      return body;
    } catch (error) {
      if (error instanceof IntakeClientError) throw error;
      throw new IntakeClientError('intake_unreachable', `Response lost or service unreachable: ${String(error)}. Read back; retry only the identical explicit decision.`);
    }
  }
}
