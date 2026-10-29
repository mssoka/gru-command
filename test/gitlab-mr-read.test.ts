import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBE_TIMEOUT_MS, defaultPrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { readGitLabMr, recordGitLabMrRead } from '../src/dispatch/perkins-review/gitlab-mr-read.js';
import { parseGitLabMrLink, parseGitLabMrPath } from '../src/dispatch/review-path.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

/**
 * The GitLab merge-request reader behind a native round's CI evidence (#519):
 * the request it makes, how every answer is classified, and that no
 * credential survives into anything it records. The freeze wiring is pinned
 * in review-gitlab-ci-wave.test.ts.
 */

const HOST = 'gitlab.example.test';
const PROJECT = 'acme/platform/app';
const TARGET = 'c7d2f34d633457c225732ed04fe82554d14c4501';
const SENTINEL = 'glpat-SENTINEL-9f3b1c7e5a2d4086';
const REQUEST = { host: HOST, project: PROJECT, iid: 7 };
const URL_FOR_REQUEST = `https://${HOST}/api/v4/projects/acme%2Fplatform%2Fapp/merge_requests/7`;
const ENV = { GITLAB_TOKEN: SENTINEL } as const;

function mrBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 7,
    state: 'opened',
    sha: TARGET,
    web_url: `https://${HOST}/${PROJECT}/-/merge_requests/7`,
    head_pipeline: {
      id: 4242, sha: TARGET, status: 'success', source: 'merge_request_event',
      web_url: `https://${HOST}/${PROJECT}/-/pipelines/4242`,
    },
    ...overrides,
  };
}

interface Call { readonly url: string; readonly init: RequestInit | undefined }

function double(answer: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchDouble = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetch: fetchDouble };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('GitLab merge request link parsing', () => {
  it('reads the project (subgroups kept) and iid from an MR path, trailing slash allowed', () => {
    expect(parseGitLabMrPath('/acme/platform/app/-/merge_requests/7')).toEqual({ project: 'acme/platform/app', iid: '7' });
    expect(parseGitLabMrPath('/acme/app/-/merge_requests/12/')).toEqual({ project: 'acme/app', iid: '12' });
    expect(parseGitLabMrPath('/acme/app/-/merge_requests/12/diffs')).toBeNull();
    expect(parseGitLabMrPath('/acme/app/merge_requests/12')).toBeNull();
    expect(parseGitLabMrPath('/acme/app/pull/12')).toBeNull();
    expect(parseGitLabMrPath('/-/merge_requests/12')).toBeNull();
  });

  it('accepts only https links without credentials on a GitLab host, and names an MR-shaped link on another host', () => {
    expect(parseGitLabMrLink(`https://${HOST}/${PROJECT}/-/merge_requests/7`)).toEqual({
      kind: 'supported', host: HOST, project: PROJECT, iid: 7,
    });
    expect(parseGitLabMrLink('https://GitLab.COM/acme/app/-/merge_requests/3')).toEqual({
      kind: 'supported', host: 'gitlab.com', project: 'acme/app', iid: 3,
    });
    for (const link of [
      'https://git.example.test/acme/app/-/merge_requests/3',
      'https://evil.gitlab.attacker.test/acme/app/-/merge_requests/3',
      'https://github.com/acme/app/-/merge_requests/3',
      // GitHub claims this host first, as the head probe's dispatch does.
      'https://gitlab.github.com/acme/app/-/merge_requests/3',
    ]) expect(parseGitLabMrLink(link), link).toEqual({ kind: 'unsupported-host' });
    for (const link of [
      `http://${HOST}/acme/app/-/merge_requests/3`,
      `https://user:pass@${HOST}/acme/app/-/merge_requests/3`,
      `https://${HOST}/acme/app/-/merge_requests/99999999999999999999`,
      `https://${HOST}/acme/app/issues/3`,
      'https://github.com/acme/app/pull/3',
      'not a url',
      '',
    ]) expect(parseGitLabMrLink(link), link).toBeNull();
  });
});

describe('readGitLabMr', () => {
  it('makes the head probe request: one GET with the PRIVATE-TOKEN header, a timeout and no redirect following', async () => {
    const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
    const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_FOR_REQUEST);
    expect(calls[0]!.init?.headers).toEqual({ 'PRIVATE-TOKEN': SENTINEL });
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(outcome).toEqual({
      ok: true,
      observed: {
        host: HOST, project: PROJECT, mr_iid: 7, state: 'opened', head_sha: TARGET,
        head_pipeline: {
          id: 4242, sha: TARGET, status: 'success', source: 'merge_request_event',
          web_url: `https://${HOST}/${PROJECT}/-/pipelines/4242`,
        },
      },
    });
  });

  it('resolves the token as the head probe does: GITLAB_TOKEN, then GL_TOKEN, an empty value is missing', async () => {
    for (const [env, sent] of [
      [{ GITLAB_TOKEN: 'primary', GL_TOKEN: 'secondary' }, 'primary'],
      [{ GL_TOKEN: 'secondary' }, 'secondary'],
    ] as const) {
      const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
      await readGitLabMr(REQUEST, { fetch: fetchDouble, env });
      expect((calls[0]!.init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe(sent);
    }
    for (const env of [{}, { GITLAB_TOKEN: '' }, { GITLAB_TOKEN: '   ' }, { GITLAB_TOKEN: '', GL_TOKEN: 'secondary' }]) {
      const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env });
      expect(calls, JSON.stringify(env)).toHaveLength(0);
      expect(outcome).toMatchObject({ ok: false, failure: { error_kind: 'token-missing', host: HOST, project: PROJECT, mr_iid: 7 } });
    }
  });

  it('refuses to attach a token to a host the service does not support, before any request', async () => {
    const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
    for (const host of ['git.example.test', 'github.com', 'evil.gitlab.attacker.test', 'gitlab.github.com']) {
      await expect(readGitLabMr({ ...REQUEST, host }, { fetch: fetchDouble, env: ENV })).rejects.toThrow(/not a GitLab host/u);
    }
    expect(calls).toHaveLength(0);
  });

  it('classifies HTTP statuses: 401 auth, 403 permission, 404 not-found, 429 rate-limit, anything else other', async () => {
    const expected: ReadonlyArray<readonly [number, string]> = [
      [401, 'auth'], [403, 'permission'], [404, 'not-found'], [429, 'rate-limit'],
      [400, 'other'], [302, 'other'], [500, 'other'], [503, 'other'], [418, 'other'],
    ];
    for (const [status, kind] of expected) {
      const { fetch: fetchDouble } = double(() => new Response('{"message":"nope"}', { status }));
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(outcome, String(status)).toMatchObject({
        ok: false, failure: { error_kind: kind, host: HOST, project: PROJECT, mr_iid: 7 },
      });
      expect(outcome.ok ? '' : outcome.failure.detail, String(status)).toContain(`HTTP ${status}`);
    }
  });

  it('classifies a rejection named TimeoutError as timeout and every other rejection as other', async () => {
    const timeoutLike = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    for (const [rejection, kind] of [
      [timeoutLike, 'timeout'],
      [new DOMException('timed out', 'TimeoutError'), 'timeout'],
      [new TypeError('fetch failed'), 'other'],
      [new DOMException('aborted', 'AbortError'), 'other'],
      ['plain string', 'other'],
    ] as const) {
      const { fetch: fetchDouble } = double(() => { throw rejection; });
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(outcome, String(rejection)).toMatchObject({ ok: false, failure: { error_kind: kind } });
    }
  });

  it('classifies a body that is not a usable merge request as other', async () => {
    const lacking = (key: string): Record<string, unknown> => {
      const { [key]: _removed, ...rest } = mrBody();
      return rest;
    };
    const bodies: ReadonlyArray<readonly [string, string]> = [
      ['not json', '<html>502</html>'],
      ['empty', ''],
      ['an array', '[]'],
      ['null', 'null'],
      ['no web_url', JSON.stringify(lacking('web_url'))],
      ['no iid', JSON.stringify(lacking('iid'))],
      ['no state', JSON.stringify(lacking('state'))],
      ['no sha', JSON.stringify(lacking('sha'))],
      ['a null sha', JSON.stringify(mrBody({ sha: null }))],
      ['a string iid', JSON.stringify(mrBody({ iid: '7' }))],
      ['a web_url that is not an MR url', JSON.stringify(mrBody({ web_url: `https://${HOST}/${PROJECT}` }))],
      ['a web_url that is not a url', JSON.stringify(mrBody({ web_url: 'nonsense' }))],
      ['a head_pipeline without an id', JSON.stringify(mrBody({ head_pipeline: { sha: TARGET, status: 'success' } }))],
      ['a head_pipeline that is a string', JSON.stringify(mrBody({ head_pipeline: 'success' }))],
    ];
    for (const [label, body] of bodies) {
      const { fetch: fetchDouble } = double(() => new Response(body, { status: 200 }));
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(outcome, label).toMatchObject({ ok: false, failure: { error_kind: 'other' } });
    }
  });

  it('takes host, project and iid from the response web_url and iid, never from the request', async () => {
    const { fetch: fetchDouble } = double(() => json(mrBody({
      iid: 9,
      web_url: 'https://GitLab.Example.Test/acme/renamed/app/-/merge_requests/9',
    })));
    const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
    expect(outcome).toMatchObject({ ok: true, observed: { host: HOST, project: 'acme/renamed/app', mr_iid: 9 } });
  });

  it('records a missing head pipeline as null, and missing pipeline source and url as null', async () => {
    for (const absent of [{ head_pipeline: null }, { head_pipeline: undefined }]) {
      const { fetch: fetchDouble } = double(() => json(mrBody(absent)));
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(outcome).toMatchObject({ ok: true, observed: { head_pipeline: null } });
    }
    const { fetch: fetchDouble } = double(() => json(mrBody({ head_pipeline: { id: 5, sha: TARGET, status: 'running' } })));
    expect(await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV })).toMatchObject({
      ok: true, observed: { head_pipeline: { id: 5, sha: TARGET, status: 'running', source: null, web_url: null } },
    });
  });

  it('redacts the token from a response body and from a rejection message, and bounds the detail', async () => {
    const echoes: ReadonlyArray<readonly [string, () => Response]> = [
      ['a 500 body', () => new Response(`internal error while handling PRIVATE-TOKEN ${SENTINEL} ${'x'.repeat(2000)}`, { status: 500 })],
      ['a 401 body', () => new Response(JSON.stringify({ message: `bad token ${SENTINEL}` }), { status: 401 })],
    ];
    for (const [label, answer] of echoes) {
      const { fetch: fetchDouble } = double(answer);
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(outcome.ok, label).toBe(false);
      const detail = outcome.ok ? '' : outcome.failure.detail;
      expect(detail, label).not.toContain(SENTINEL);
      expect(detail, label).toContain('[redacted]');
      expect(detail.length, label).toBeLessThanOrEqual(300);
    }
    const { fetch: rejecting } = double(() => { throw new TypeError(`connect failed using ${SENTINEL} as the token`); });
    const rejected = await readGitLabMr(REQUEST, { fetch: rejecting, env: ENV });
    const detail = rejected.ok ? '' : rejected.failure.detail;
    expect(detail).not.toContain(SENTINEL);
    expect(detail).toContain('[redacted]');
  });

  it('redacts a padded token in both its spellings and credential-shaped text in the body', async () => {
    const padded = `  ${SENTINEL}  `;
    const { fetch: fetchDouble } = double(() => new Response(`padded [${padded}] trimmed [${SENTINEL}] password=hunter2hunter2`, { status: 500 }));
    const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: { GITLAB_TOKEN: padded } });
    const detail = outcome.ok ? '' : outcome.failure.detail;
    expect(detail).not.toContain(SENTINEL);
    expect(detail).not.toContain('hunter2hunter2');
    expect(detail).toContain('[REDACTED]');
  });

  it('bounds the request with the head probe timeout, and a real expiry of that signal is the timeout kind', async () => {
    const expired = AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => expired);
    try {
      const { calls, fetch: fetchDouble } = double(({ init }) => {
        if (init?.signal?.aborted === true) throw init.signal.reason;
        return json(mrBody());
      });
      const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV });
      expect(timeoutSpy).toHaveBeenCalledWith(PROBE_TIMEOUT_MS);
      expect(PROBE_TIMEOUT_MS).toBe(30_000);
      expect(calls).toHaveLength(1);
      expect(outcome).toMatchObject({ ok: false, failure: { error_kind: 'timeout' } });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('cancels the request with the caller\'s signal', async () => {
    const controller = new AbortController();
    const { fetch: fetchDouble } = double(({ init }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      controller.abort();
    }));
    const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: ENV, signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, failure: { error_kind: 'other' } });
  });

  it('makes the same request the production head probe makes for the same link', async () => {
    const saved = { GITLAB_TOKEN: process.env['GITLAB_TOKEN'], GL_TOKEN: process.env['GL_TOKEN'] };
    process.env['GITLAB_TOKEN'] = 'tok_probe_plain_7c1d';
    delete process.env['GL_TOKEN'];
    const probeCalls: Call[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      probeCalls.push({ url: String(input), init });
      return json({ source_branch: 'feature/review', sha: TARGET });
    }) as typeof fetch);
    try {
      const head = await defaultPrHeadProbe({ prUrl: `https://${HOST}/${PROJECT}/-/merge_requests/7`, repoPath: '', branchRef: '' });
      expect(head).toEqual({ headRefName: 'feature/review', headSha: TARGET });
      const readerCalls = double(() => json(mrBody()));
      await readGitLabMr(REQUEST, { fetch: readerCalls.fetch, env: { GITLAB_TOKEN: 'tok_probe_plain_7c1d' } });
      expect(probeCalls).toHaveLength(1);
      expect(readerCalls.calls).toHaveLength(1);
      expect(probeCalls[0]!.url).toBe(URL_FOR_REQUEST);
      expect(readerCalls.calls[0]!.url).toBe(probeCalls[0]!.url);
      expect(readerCalls.calls[0]!.init?.headers).toEqual(probeCalls[0]!.init?.headers);
      expect(probeCalls[0]!.init?.headers).toEqual({ 'PRIVATE-TOKEN': 'tok_probe_plain_7c1d' });
    } finally {
      fetchSpy.mockRestore();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('replaces both spellings of a padded token that no credential pattern recognises', async () => {
    const plain = 'tok_Plain9f3b1c7e5a2d4086';
    const padded = `  ${plain}  `;
    const { fetch: fetchDouble } = double(() => new Response(`one [${padded}] two [${plain}] three`, { status: 500 }));
    const outcome = await readGitLabMr(REQUEST, { fetch: fetchDouble, env: { GITLAB_TOKEN: padded } });
    const detail = outcome.ok ? '' : outcome.failure.detail;
    expect(detail).toBe('GitLab answered HTTP 500: one [[redacted]] two [[redacted]] three');
  });

  it('puts no token in a thrown error either', async () => {
    const { fetch: fetchDouble } = double(() => json(mrBody()));
    const thrown = await readGitLabMr({ ...REQUEST, host: 'github.com' }, { fetch: fetchDouble, env: ENV }).catch((error: unknown) => error);
    expect(String(thrown)).not.toContain(SENTINEL);
  });
});

describe('recordGitLabMrRead', () => {
  const dirs: string[] = [];
  const dbs: LedgerDb[] = [];
  afterEach(() => {
    while (dbs.length > 0) dbs.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function ledger(): LedgerApi {
    const dir = mkdtempSync(join(tmpdir(), 'gru-gitlab-mr-read-'));
    dirs.push(dir);
    const db = new LedgerDb(dir);
    dbs.push(db);
    const api = new LedgerApi(db.handle, { bus: new EventBus() });
    api.addJob({ id: 'job-1', repo: 'fixture', title: 'gitlab mr' });
    return api;
  }

  const gitlabEvents = (api: LedgerApi) => api.listEvents({ limit: 100 }).filter((entry) => entry.kind.startsWith('gitlab.'));

  it('records exactly one gitlab.mr-observed event for a supported link and returns it with the link identity', async () => {
    const api = ledger();
    const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const recorded = await recordGitLabMrRead({
      ledger: api, jobId: 'job-1', roundId: 'round-1', prUrl: `https://${HOST}/${PROJECT}/-/merge_requests/7`,
      deps: { fetch: fetchDouble, env: ENV },
      log: (level, msg, fields) => logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }),
    });
    expect(calls).toHaveLength(1);
    const events = gitlabEvents(api);
    expect(events).toHaveLength(1);
    expect(recorded).toEqual({ event: expect.objectContaining({ seq: events[0]!.seq, kind: 'gitlab.mr-observed' }), link: REQUEST });
    expect(events[0]).toMatchObject({
      kind: 'gitlab.mr-observed', jobId: 'job-1', roundId: 'round-1',
      payload: {
        host: HOST, project: PROJECT, mr_iid: 7, state: 'opened', head_sha: TARGET, round_id: 'round-1',
        head_pipeline: {
          id: 4242, sha: TARGET, status: 'success', source: 'merge_request_event',
          web_url: `https://${HOST}/${PROJECT}/-/pipelines/4242`,
        },
      },
    });
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(
      ['head_pipeline', 'head_sha', 'host', 'mr_iid', 'project', 'round_id', 'state'],
    );
    expect(logs.map((entry) => entry.level)).toEqual(['info']);
  });

  it('records exactly one gitlab.mr-read-failed event with request identity when the read fails', async () => {
    const api = ledger();
    const { fetch: fetchDouble } = double(() => new Response(`boom ${SENTINEL}`, { status: 503 }));
    const logs: string[] = [];
    const recorded = await recordGitLabMrRead({
      ledger: api, jobId: 'job-1', roundId: 'round-2', prUrl: `https://${HOST}/${PROJECT}/-/merge_requests/7`,
      deps: { fetch: fetchDouble, env: ENV },
      log: (level, msg, fields) => logs.push(JSON.stringify({ level, msg, fields })),
    });
    const events = gitlabEvents(api);
    expect(events).toHaveLength(1);
    expect(recorded?.event.kind).toBe('gitlab.mr-read-failed');
    expect(events[0]).toMatchObject({
      kind: 'gitlab.mr-read-failed', jobId: 'job-1', roundId: 'round-2',
      payload: { host: HOST, project: PROJECT, mr_iid: 7, error_kind: 'other', round_id: 'round-2' },
    });
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(['detail', 'error_kind', 'host', 'mr_iid', 'project', 'round_id']);
    expect(JSON.stringify(api.listEvents({ limit: 100 }))).not.toContain(SENTINEL);
    expect(logs.join('\n')).not.toContain(SENTINEL);
    expect(logs).toHaveLength(1);
  });

  it('makes no request and records nothing for a missing link, a GitHub link, or a link on a rejected host', async () => {
    const api = ledger();
    const { calls, fetch: fetchDouble } = double(() => json(mrBody()));
    for (const prUrl of [
      null,
      'https://github.com/acme/app/pull/3',
      'https://git.example.test/acme/app/-/merge_requests/3',
      'https://evil.gitlab.attacker.test/acme/app/-/merge_requests/3',
      `http://${HOST}/acme/app/-/merge_requests/3`,
      'garbage',
    ]) {
      const recorded = await recordGitLabMrRead({
        ledger: api, jobId: 'job-1', roundId: 'round-1', prUrl, deps: { fetch: fetchDouble, env: ENV },
      });
      expect(recorded, String(prUrl)).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(gitlabEvents(api)).toHaveLength(0);
  });
});
