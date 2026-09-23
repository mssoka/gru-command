import { defineConfig } from '@playwright/test';
import { assertSafeTestServicePort } from '../test/helpers/real-service.mjs';

/**
 * Two smoke surfaces, one serial run:
 *
 *  - `mock`   — the dev-only mock socket (web/mock/server.ts) behind a
 *               vite preview proxy. Dev tooling; stays green.
 *  - `real`   — the REAL service (repo dist/main.js) serving web/dist on
 *               its own port with the real /ws socket, real token flow,
 *               and the offline claude CLI double as the Gru runtime
 *               (test/helpers/real-service.mjs — hermetic, no network).
 *               The service is TEST-managed (e2e/real-server.spec.ts
 *               boots/stops/restarts it) so the restart test can bounce
 *               it mid-flight.
 *
 * Serial workers: both servers' frame logs are shared state across tests.
 * snapshotPathTemplate keeps the committed E5 baseline names (no project
 * suffix); the real specs use distinct `real-*` snapshot names.
 */
const MOCK_PORT = 8788;
const PREVIEW_PORT = 4173;
const REAL_PORT = Number(process.env.REAL_SERVICE_PORT ?? 7790);
// Port-squat prevention (owner incident 2026-09-23): the e2e service is a
// test service — ephemeral or an explicit high-range override, never the
// instance port. Refuse before a single browser spec runs.
assertSafeTestServicePort(REAL_PORT, 'playwright real service');
assertSafeTestServicePort(MOCK_PORT, 'playwright mock service');
assertSafeTestServicePort(PREVIEW_PORT, 'playwright preview service');

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  snapshotPathTemplate: '{snapshotDir}/{testFileName}-snapshots/{arg}-{platform}{ext}',
  webServer: [
    {
      command: 'npm run mock',
      env: {
        GRU_MOCK_PORT: String(MOCK_PORT),
        GRU_MOCK_TOKEN: process.env.GRU_MOCK_TOKEN ?? 'dev-token',
      },
      port: MOCK_PORT,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      env: { GRU_MOCK_PORT: String(MOCK_PORT) },
      port: PREVIEW_PORT,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: 'mock',
      testMatch: 'smoke.spec.ts',
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      name: 'real',
      testMatch: 'real-server.spec.ts',
      use: { baseURL: `http://localhost:${REAL_PORT}` },
    },
  ],
});
