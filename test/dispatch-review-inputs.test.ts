import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { DispatchService } from '../src/dispatch/service.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

const TOKEN = 'review-inputs-token';
const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly reviewCalls: unknown[];
  close(): Promise<void>;
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-review-inputs-http-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const reviewCalls: unknown[] = [];
  const wave = {
    requestReview: async (input: unknown) => {
      reviewCalls.push(input);
      return { route: 'queued', jobId: (input as { jobId: string }).jobId, requestSeq: 1, run: Promise.resolve() };
    },
    resumeQueuedHandoffs: () => {},
    shutdown: async () => {},
  } as unknown as WaveRunner;
  const dispatch = { worktreesFor: () => [] } as unknown as DispatchService;
  const server = createDispatchServer({ config: cfg, dispatch, wave, ledger, pendingProducerBlockers: () => [] });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    ledger,
    reviewCalls,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      db.close();
    },
  };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const BRIEFING = 'Goal: ship it.\nAcceptance 1: fixed entry point.';

describe('dispatch review-input surfaces', () => {
  it('rejects unauthenticated amendments and audits missing approval provenance', async () => {
    const h = await boot();
    try {
      const anon = await call(h.port, 'POST', '/api/dispatch/amendment', { job_id: 'j' }, null);
      expect(anon.status).toBe(401);
      h.ledger.addJob({ id: 'j', repo: 'repo', title: 't', briefing: BRIEFING });
      const missing = await call(h.port, 'POST', '/api/dispatch/amendment', {
        job_id: 'j',
        body: 'amendment',
        expected_contract_sha256: sha256(BRIEFING),
      });
      expect(missing.status).toBe(400);
      expect(missing.json['error']).toBe('improper_authorization');
      // A null approval is the same authorization failure, not a parse crash.
      const nullApproval = await call(h.port, 'POST', '/api/dispatch/amendment', {
        job_id: 'j',
        body: 'amendment',
        approval: null,
        expected_contract_sha256: sha256(BRIEFING),
      });
      expect(nullApproval.status).toBe(400);
      expect(nullApproval.json['error']).toBe('improper_authorization');
      const unknownJob = await call(h.port, 'POST', '/api/dispatch/amendment', {
        job_id: 'missing-job',
        body: 'amendment',
        approval: { by: 'owner', reference: 'j-969' },
        expected_contract_sha256: sha256(BRIEFING),
      });
      expect(unknownJob.status).toBe(404);
      expect(unknownJob.json['error']).toBe('job-not-found');
      const rejected = h.ledger.listJobAmendments('j');
      expect(rejected).toHaveLength(0);
      const audit = h.ledger.listEvents().filter((event) => event.kind === 'job.amendment-rejected');
      expect(audit).toHaveLength(3);
      expect(audit.map((event) => (event.payload as { code?: string }).code)).toEqual([
        'job-not-found',
        'improper-authorization',
        'improper-authorization',
      ]);
    } finally {
      await h.close();
    }
  });

  it('answers contract reads with 401 for anonymous callers and 404 for unknown jobs', async () => {
    const h = await boot();
    try {
      const anon = await call(h.port, 'GET', '/api/dispatch/jobs/j/contract', undefined, null);
      expect(anon.status).toBe(401);
      const missing = await call(h.port, 'GET', '/api/dispatch/jobs/missing/contract');
      expect(missing.status).toBe(404);
      expect(missing.json['error']).toBe('job_not_found');
    } finally {
      await h.close();
    }
  });

  it('accepts, reads back, conflicts and idempotently retries an amendment over HTTP', async () => {
    const h = await boot();
    try {
      h.ledger.addJob({ id: 'j', repo: 'repo', title: 't', briefing: BRIEFING });
      const before = await call(h.port, 'GET', '/api/dispatch/jobs/j/contract');
      expect(before.status).toBe(200);
      expect(before.json['version']).toBe(0);
      expect(before.json['effective_contract']).toBe(BRIEFING);
      const expected = before.json['contract_sha256'] as string;
      const payload = {
        job_id: 'j',
        body: 'Acceptance 1 is superseded: use task-relevant installed skills.',
        supersedes: ['original:Acceptance 1'],
        approval: { by: 'owner', reference: 'epoch12 seq194760' },
        expected_contract_sha256: expected,
      };
      const accepted = await call(h.port, 'POST', '/api/dispatch/amendment', payload);
      expect(accepted.status).toBe(200);
      expect(accepted.json['status']).toBe('accepted');
      expect(accepted.json['idempotent']).toBe(false);
      const after = await call(h.port, 'GET', '/api/dispatch/jobs/j/contract');
      expect(after.json['version']).toBe(1);
      expect(after.json['effective_contract']).toContain('Acceptance 1 is superseded');
      expect(after.json['effective_contract']).toContain(BRIEFING);
      // Stale writer refused with the current hash.
      const stale = await call(h.port, 'POST', '/api/dispatch/amendment', { ...payload, body: 'other' });
      expect(stale.status).toBe(409);
      expect(stale.json['error']).toBe('stale');
      expect(stale.json['current_contract_sha256']).toBe(after.json['contract_sha256']);
      // Idempotent retry returns the same amendment.
      const retried = await call(h.port, 'POST', '/api/dispatch/amendment', { ...payload, idempotency_key: 'k1' });
      expect(retried.status).toBe(409); // idempotency key did not exist on the first request
      const keyed = await call(h.port, 'POST', '/api/dispatch/amendment', {
        ...payload,
        body: 'Retry-only amendment.',
        idempotency_key: 'k2',
        expected_contract_sha256: after.json['contract_sha256'],
      });
      expect(keyed.status).toBe(200);
      const keyRetried = await call(h.port, 'POST', '/api/dispatch/amendment', {
        ...payload,
        body: 'Retry-only amendment.',
        idempotency_key: 'k2',
        expected_contract_sha256: after.json['contract_sha256'],
      });
      expect(keyRetried.status).toBe(200);
      expect(keyRetried.json['idempotent']).toBe(true);
      expect((keyRetried.json['amendment'] as { id: string }).id).toBe((keyed.json['amendment'] as { id: string }).id);
      // The same key with a different request is a conflict, not a bad request.
      const conflict = await call(h.port, 'POST', '/api/dispatch/amendment', {
        ...payload,
        body: 'A different request with the same key.',
        idempotency_key: 'k2',
        expected_contract_sha256: after.json['contract_sha256'],
      });
      expect(conflict.status).toBe(409);
      expect(conflict.json['error']).toBe('idempotency-conflict');
    } finally {
      await h.close();
    }
  });

  it('passes authorized evidence references through the review arm and refuses malformed ones', async () => {
    const h = await boot();
    try {
      h.ledger.addJob({ id: 'j', repo: 'repo', title: 't', briefing: BRIEFING });
      const ok = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'j',
        evidence: [
          {
            upload_path: '/data/uploads/123-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ref.png',
            purpose: 'owner reference render; NOT rendered at the frozen revision',
            consent_ref: 'owner approval j-969',
            captured_at: '2026-10-01',
          },
        ],
      });
      expect(ok.status).toBe(202);
      const input = h.reviewCalls[0] as { evidence: Array<{ uploadPath: string; purpose: string; consentRef: string }> };
      expect(input.evidence).toHaveLength(1);
      expect(input.evidence[0]!.uploadPath).toBe('/data/uploads/123-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ref.png');
      expect(input.evidence[0]!.consentRef).toBe('owner approval j-969');
      const unknown = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'j',
        evidence: [{ upload_path: '/x', purpose: 'p', consent_ref: 'c', extra: true }],
      });
      expect(unknown.status).toBe(400);
      const missingConsent = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'j',
        evidence: [{ upload_path: '/x', purpose: 'p' }],
      });
      expect(missingConsent.status).toBe(400);
      const tooMany = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'j',
        evidence: Array.from({ length: 5 }, (_, index) => ({ upload_path: `/x/${index}`, purpose: 'p', consent_ref: 'c' })),
      });
      expect(tooMany.status).toBe(400);
      expect(h.reviewCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
