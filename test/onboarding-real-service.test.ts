import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * Onboarding through the REAL composition (#427): the compiled service boots
 * and answers its onboarding route itself. Removing main's request-hook
 * wiring turns this answer into the board's 404 and fails the test.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('compiled service: the onboarding route is wired (#427)', () => {
  it('POST /api/onboarding/propose answers through the service hook chain: authed, refusing a repository outside managed_repos', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-onboarding-real-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-onboarding-real-workspace-'));
    cleanup.push(home, workspace);
    const token = 'onboarding-real-token';
    const service = await startRealService({ port: await pickFreePort(), token, home, workspace, keepHome: true, requireWebDist: false });
    try {
      const propose = async (auth: boolean): Promise<{ status: number; json: Record<string, unknown> }> => {
        const response = await fetch(`http://127.0.0.1:${service.port}/api/onboarding/propose`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ repo: 'swift-app' }),
        });
        return { status: response.status, json: (await response.json()) as Record<string, unknown> };
      };
      expect((await propose(false)).status).toBe(401);
      expect(await propose(true)).toEqual({ status: 422, json: expect.objectContaining({ error: 'not_managed', detail: expect.stringContaining('managed_repos: none') }) });
    } finally {
      await service.stop();
    }
  }, 60_000);
});
