import { defineConfig } from 'vite';

/**
 * Dev server + preview both proxy `/ws` to the mock chat socket.
 * The mock is dev tooling (web/mock/); production serving wires into the
 * service when E4 lands — see docs/UI.md.
 */
const mockPort = Number(process.env.GRU_MOCK_PORT ?? 8787);

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${mockPort}`, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/ws': { target: `ws://localhost:${mockPort}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
