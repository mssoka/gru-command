/**
 * Preloaded into the compiled service (--import): every lesson-dream pass
 * fails, so the PRODUCTION failure wiring (main → DreamScheduler hooks →
 * dreamFailureIncidents → NotificationCenter → ledger) is exercised end to
 * end. ESM modules are singletons, so patching the prototype here patches
 * the DreamEngine main constructs.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { DreamEngine } = await import(pathToFileURL(join(repoRoot, 'dist', 'lessons', 'dream.js')).href);
DreamEngine.prototype.run = async function run() {
  throw new Error('forced dream failure (test preload)');
};
