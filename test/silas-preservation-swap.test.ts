import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #367: the resolver's guards that only a filesystem fault can reach — a
 * directory swapped while the reads run, and a platform without no-follow
 * reads — driven through a mocked `node:fs` whose real calls pass through.
 */
// Hoisted with the mock factory, which runs before any other top-level code.
const { hooks, mutableConstants } = vi.hoisted(() => ({
  hooks: { onOpen: null } as { onOpen: ((path: string) => void) | null },
  mutableConstants: {} as Record<string, number | undefined>,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  Object.assign(mutableConstants, actual.constants);
  return {
    ...actual,
    constants: mutableConstants,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      hooks.onOpen?.(String(args[0]));
      return actual.openSync(...args);
    },
  };
});
const { resolvePreservationReference } = await import('../src/dispatch/silas-preservation-reference.js');

const dirs: string[] = [];
afterEach(() => {
  hooks.onOpen = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A minimal valid record (report, session, bound manifest, archive). */
function record() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'silas-preservation-swap-')));
  dirs.push(root);
  const tree = join(root, 'tree');
  mkdirSync(tree);
  writeFileSync(join(root, 'complete-original-report.md'), 'r');
  writeFileSync(join(root, 'original-source-session.jsonl'), 's');
  writeFileSync(join(root, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'), 'archive');
  const manifest = JSON.stringify({ original_tree: tree, relative_entries: [], archive_sha256: sha256('archive') });
  writeFileSync(join(root, 'link-preservation-manifest.json'), manifest);
  const text = JSON.stringify({
    job: { id: 'job-h1', repo: 'fixture-repo' }, tree: { job_id: 'job-h1', path: tree },
    original_report_sha256: sha256('r'), original_session_sha256: sha256('s'), link_manifest_sha256: sha256(manifest),
  });
  const recordPath = join(root, 'original-custody-and-retention-preflight.json');
  writeFileSync(recordPath, text);
  return { tree, reference: { recordPath, recordSha256: sha256(text) } };
}

describe('preservation reference — faults only a filesystem can cause (#367)', () => {
  it('verifies the unfaulted record (control)', () => {
    const { reference } = record();
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' })).toMatchObject({ reusable: true });
  });

  it('refuses when the original tree is swapped for another directory while the reads run', () => {
    const { tree, reference } = record();
    hooks.onOpen = (path) => {
      if (!path.endsWith('.tar.gz')) return;
      hooks.onOpen = null;
      renameSync(tree, `${tree}.moved`);
      mkdirSync(tree);
    };
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringMatching(/the record directory or the original tree changed while it was being verified/u) });
  });

  it('refuses on a platform without no-follow reads, by name', () => {
    const { reference } = record();
    const noFollow = mutableConstants['O_NOFOLLOW'];
    delete mutableConstants['O_NOFOLLOW'];
    try {
      expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
        .toMatchObject({ reusable: false, guidance: expect.stringMatching(/no-follow file reads are unsupported on this platform/u) });
    } finally { mutableConstants['O_NOFOLLOW'] = noFollow; }
  });
});
