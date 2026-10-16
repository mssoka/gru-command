import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  return { root, tree, reference: { recordPath, recordSha256: sha256(text) } };
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
      .toMatchObject({ reusable: false, guidance: `the record directory or the original tree changed while it was being verified (${tree} was replaced by another directory) — the tree is retained` });
  });

  it('refuses when the record directory is swapped for another directory while the reads run', () => {
    const { root, reference } = record();
    hooks.onOpen = (path) => {
      if (!path.endsWith('.tar.gz')) return;
      hooks.onOpen = null;
      // The same files at the same path, in a different directory.
      cpSync(root, `${root}.copy`, { recursive: true });
      renameSync(root, `${root}.moved`);
      renameSync(`${root}.copy`, root);
      dirs.push(`${root}.moved`);
    };
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: `the record directory or the original tree changed while it was being verified (${root} was replaced by another directory) — the tree is retained` });
  });

  it('refuses a tree deleted and re-created at the same path, and one that vanished, by name', () => {
    const recreated = record();
    hooks.onOpen = (path) => {
      if (!path.endsWith('.tar.gz')) return;
      hooks.onOpen = null;
      rmSync(recreated.tree, { recursive: true });
      mkdirSync(recreated.tree);
    };
    expect(resolvePreservationReference({ reference: recreated.reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`(${recreated.tree} was replaced by another directory)`) });
    const vanished = record();
    hooks.onOpen = (path) => {
      if (!path.endsWith('.tar.gz')) return;
      hooks.onOpen = null;
      rmSync(vanished.tree, { recursive: true });
    };
    expect(resolvePreservationReference({ reference: vanished.reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`(${vanished.tree} vanished or cannot be read)`) });
  });

  it('refuses when a verified link\'s directory is swapped while the reads run', () => {
    const { root, tree, reference: original } = record();
    mkdirSync(join(tree, 'nested'));
    symlinkSync('../outside-target', join(tree, 'nested', 'link'));
    // Re-bind the record to a manifest that names the nested link.
    const manifest = JSON.stringify({ original_tree: tree, relative_entries: ['nested/link'], archive_sha256: sha256('archive') });
    writeFileSync(join(root, 'link-preservation-manifest.json'), manifest);
    const text = JSON.stringify({
      job: { id: 'job-h1', repo: 'fixture-repo' }, tree: { job_id: 'job-h1', path: tree },
      original_report_sha256: sha256('r'), original_session_sha256: sha256('s'), link_manifest_sha256: sha256(manifest),
    });
    writeFileSync(original.recordPath, text);
    const reference = { recordPath: original.recordPath, recordSha256: sha256(text) };
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' })).toMatchObject({ reusable: true, verifiedAssets: expect.arrayContaining(['link:nested/link']) });
    hooks.onOpen = (path) => {
      if (!path.endsWith('.tar.gz')) return;
      hooks.onOpen = null;
      renameSync(join(tree, 'nested'), join(tree, 'nested.moved'));
      mkdirSync(join(tree, 'nested'));
    };
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`(${join(tree, 'nested')} was replaced by another directory)`) });
  });

  it('refuses on a platform without no-follow reads, by name', () => {
    const { reference } = record();
    const noFollow = mutableConstants['O_NOFOLLOW'];
    delete mutableConstants['O_NOFOLLOW'];
    try {
      expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
        .toMatchObject({ reusable: false, guidance: expect.stringMatching(/no-follow file reads are unsupported on this platform/u) });
    } finally {
      if (noFollow === undefined) delete mutableConstants['O_NOFOLLOW']; else mutableConstants['O_NOFOLLOW'] = noFollow;
    }
  });
});
