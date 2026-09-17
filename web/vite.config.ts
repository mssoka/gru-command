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
      '/board/ws': { target: `ws://localhost:${mockPort}`, ws: true },
      '/api': { target: `http://localhost:${mockPort}` },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/ws': { target: `ws://localhost:${mockPort}`, ws: true },
      '/board/ws': { target: `ws://localhost:${mockPort}`, ws: true },
      '/api': { target: `http://localhost:${mockPort}` },
    },
  },
  build: {
    outDir: 'dist',
    // No public sourcemaps on the production bundle; vite dev has its own.
    sourcemap: false,
  },
});
