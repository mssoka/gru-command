import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function lines(file: string): { authorizationPresent: boolean; ambientKeyPresent: boolean; questionIds: string[] }[] {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function json(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

describe('compiled service Jev credential lifecycle', () => {
  it('boots and restarts from a CLI-stored key, drives a real caller, then disables with zero further requests', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-jev-service-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-jev-service-workspace-'));
    cleanup.push(home, workspace);
    const logFile = join(home, 'jev-fetch.jsonl');
    const preload = join(import.meta.dirname, 'helpers', 'jev-fetch-double.mjs');
    const token = 'jev-service-integration-token';
    const port = await pickFreePort();
    let service = await startRealService({
      port, token, home, workspace, keepHome: true,
      decisionsEnabled: true,
      decisionKey: 'FILE-CREDENTIAL-CANARY',
      nodeImport: preload,
      extraEnv: { JEV_FETCH_LOG: logFile },
      requireWebDist: false,
    });
    try {
      let status = await json(service.baseUrl, token, '/api/decisions/status');
      expect(status).toMatchObject({ status: 200, body: { status: 'ready', credentialSource: 'file', credentialPresent: true } });
      expect(lines(logFile)).toEqual([
        expect.objectContaining({ authorizationPresent: true, ambientKeyPresent: false }),
      ]);
      expect(readFileSync(logFile, 'utf8')).not.toContain('FILE-CREDENTIAL-CANARY');

      expect((await json(service.baseUrl, token, '/api/jobs', {
        method: 'POST', body: JSON.stringify({ id: 'jev-service-job', repo: 'demo', title: 'Jev service caller' }),
      })).status).toBe(201);
      expect((await json(service.baseUrl, token, '/api/jobs/jev-service-job/status', {
        method: 'POST', body: JSON.stringify({ status: 'working' }),
      })).status).toBe(200);
      expect((await json(service.baseUrl, token, '/api/jobs/jev-service-job/status', {
        method: 'POST', body: JSON.stringify({ status: 'blocked' }),
      })).status).toBe(200);
      await vi.waitFor(() => expect(lines(logFile).length).toBeGreaterThanOrEqual(2));
      expect(lines(logFile).some((entry) => entry.questionIds.includes('needs_action'))).toBe(true);

      await service.stop();
      service = await startRealService({
        port, token, home, workspace,
        decisionsEnabled: true,
        nodeImport: preload,
        extraEnv: { JEV_FETCH_LOG: logFile },
        requireWebDist: false,
      });
      status = await json(service.baseUrl, token, '/api/decisions/status');
      expect(status).toMatchObject({ status: 200, body: { status: 'ready', credentialSource: 'file' } });
      expect(lines(logFile).every((entry) => entry.authorizationPresent && !entry.ambientKeyPresent)).toBe(true);

      writeFileSync(join(home, 'config.toml'), '[decisions.jev]\nenabled = false\n', 'utf8');
      await vi.waitFor(async () => {
        expect((await json(service.baseUrl, token, '/api/decisions/status')).body).toMatchObject({ status: 'disabled', enabled: false });
      }, { timeout: 3_000 });
      const beforeDisabledCaller = lines(logFile).length;
      expect((await json(service.baseUrl, token, '/api/jobs', {
        method: 'POST', body: JSON.stringify({ id: 'jev-disabled-job', repo: 'demo', title: 'Disabled caller' }),
      })).status).toBe(201);
      expect((await json(service.baseUrl, token, '/api/jobs/jev-disabled-job/status', {
        method: 'POST', body: JSON.stringify({ status: 'working' }),
      })).status).toBe(200);
      expect((await json(service.baseUrl, token, '/api/jobs/jev-disabled-job/status', {
        method: 'POST', body: JSON.stringify({ status: 'blocked' }),
      })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(lines(logFile)).toHaveLength(beforeDisabledCaller);
    } finally {
      await service.stop();
    }
  }, 30_000);
});
