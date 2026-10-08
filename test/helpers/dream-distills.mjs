/**
 * Preloaded into the compiled service (--import): ONLY the distiller is
 * stubbed — Bob's judgment becomes one fixed lesson citing the batch — so
 * the production approval wiring (main → DreamEngine with proposals →
 * LessonProposals → notifier → lessons HTTP API) runs for real. ESM modules
 * are singletons, so patching the prototype patches the distiller main uses.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AgentLessonsDistiller } = await import(pathToFileURL(join(repoRoot, 'dist', 'lessons', 'distiller.js')).href);
AgentLessonsDistiller.prototype.distill = async function distill(input) {
  return {
    chapters: [
      {
        slug: 'ops-restarts',
        title: 'Ops restarts',
        summary: 'Restart discipline.',
        tags: ['ops'],
        lessons: [
          {
            slug: 'close-the-shell',
            body: 'Close the live shell before a restart (test preload).',
            journalIds: input.entries.map((entry) => entry.id),
          },
        ],
      },
    ],
  };
};
