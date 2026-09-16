import { defineConfig } from '@playwright/test';

/**
 * E2E smoke against the dev-only mock socket.
 * Two servers: the mock (tsx) and vite preview serving the built bundle,
 * proxying /ws to the mock. Serial workers: the mock log is shared state.
 */
const MOCK_PORT = 8788;
const PREVIEW_PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
  },
  webServer: [
    {
      command: 'npm run mock',
      env: { GRU_MOCK_PORT: String(MOCK_PORT) },
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
});
