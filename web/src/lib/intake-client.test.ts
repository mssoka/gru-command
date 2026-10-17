// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeClient } from './intake-client.js';
afterEach(() => { vi.unstubAllGlobals(); });
const client = () => new IntakeClient({ token: 'paired', host: 'example.test', secure: false, timeoutMs: 20 });
describe('IntakeClient exact authenticated requests', () => {
  it('keeps selected bytes and review token on explicit approval and encodes read identities', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ accepted: [], remaining: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const input = { repoPath: '/workspace/app', intakeId: 'intake', requestId: 'r1', revisionId: 'a'.repeat(64), expectedToken: 'b'.repeat(64), selected: ['one'] };
    await client().approve(input);
    expect(fetcher.mock.calls[0]).toEqual(['http://example.test/api/intake/approve', expect.objectContaining({ method: 'POST', body: JSON.stringify(input), headers: { authorization: 'Bearer paired', 'content-type': 'application/json' } })]);
    await client().readback('/repo path', 'id', 'accepted-token');
    expect(fetcher.mock.calls[1]![0]).toContain('repoPath=%2Frepo+path&token=accepted-token');
  });
  it('commissions slicing for an exact revision without a review token (#429)', async () => {
    const commission = { repoPath: '/workspace/app', intakeId: 'intake', requestId: 'r1', revisionId: 'a'.repeat(64), jobId: 'intake-slice-1', resultRequestId: 'slice-1', dispatched: true, jobStatus: 'queued' };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(commission), { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const input = { repoPath: '/workspace/app', intakeId: 'intake', requestId: 'r1', revisionId: 'a'.repeat(64) };
    expect(await client().slice(input)).toEqual(commission);
    expect(fetcher.mock.calls[0]).toEqual(['http://example.test/api/intake/slice', expect.objectContaining({ method: 'POST', body: JSON.stringify(input), headers: { authorization: 'Bearer paired', 'content-type': 'application/json' } })]);
  });
  it('preserves named stale/conflict/partial responses and identities instead of substituting a plan', async () => {
    const readback = { review: null, accepted: [{ heistId: 'one', entryId: 'entry', state: 'waiting' }], remaining: [] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'intake_partial_failure', detail: 'Retry identical approval', readback }), { status: 503 })));
    await expect(client().approve({ repoPath: '/repo', intakeId: 'id', requestId: 'r1', revisionId: 'hash', expectedToken: null, selected: ['one'] })).rejects.toMatchObject({ code: 'intake_partial_failure', readback });
  });
  it('bounds lost response recovery and never retries automatically', async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('lost')))));
    vi.stubGlobal('fetch', fetcher);
    await expect(client().readback('/repo', 'id')).rejects.toMatchObject({ code: 'intake_unreachable', message: expect.stringContaining('identical explicit decision') });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it('classifies disconnect after headers during body consumption without automatic retry', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('body disconnected')))) }));
  vi.stubGlobal('fetch', fetcher);
  await expect(client().readback('/repo', 'id')).rejects.toMatchObject({ code: 'intake_unreachable', message: expect.stringContaining('Read back') });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reads immutable revision diff with exact encoded identities and no authority POST', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ changes: [] }), { status: 200 })); vi.stubGlobal('fetch', fetcher);
  await client().diff('/repo path', 'intake', 'r1', 'r2');
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledWith('http://example.test/api/intake/intake/diff?repoPath=%2Frepo+path&from=r1&to=r2', expect.objectContaining({ headers: { authorization: 'Bearer paired' } }));
});
