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
  hooks: { onOpen: null, onLstat: null, onRealpath: null } as {
    onOpen: ((path: string) => void) | null;
    onLstat: ((path: string, stat: unknown) => unknown) | null;
    onRealpath: ((path: string, real: string) => string) | null;
  },
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
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      return hooks.onLstat === null ? stat : hooks.onLstat(String(args[0]), stat);
    }) as typeof actual.lstatSync,
    realpathSync: Object.assign((...args: Parameters<typeof actual.realpathSync>) => {
      const real = actual.realpathSync(...args);
      return hooks.onRealpath === null ? real : hooks.onRealpath(String(args[0]), String(real));
    }, { native: actual.realpathSync.native }) as typeof actual.realpathSync,
  };
});
const { resolvePreservationReference } = await import('../src/dispatch/silas-preservation-reference.js');

const dirs: string[] = [];
afterEach(() => {
  hooks.onOpen = null; hooks.onLstat = null; hooks.onRealpath = null;
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
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`verified (${root} was replaced by another directory`) });
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

  /** A stat as if the directory were born later: same device and inode. */
  const reborn = (stat: unknown): unknown => Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as object, stat, { birthtimeNs: (stat as { birthtimeNs: bigint }).birthtimeNs + 1n });
  const bigintStat = (stat: unknown): boolean => typeof (stat as { birthtimeNs?: unknown }).birthtimeNs === 'bigint';

  it('refuses a directory whose birth time changed on the same inode (a recycled inode)', () => {
    const { tree, reference } = record();
    let armed = false;
    let fired = 0;
    hooks.onOpen = (path) => { if (path.endsWith('.tar.gz')) armed = true; };
    hooks.onLstat = (path, stat) => (armed && path === tree && bigintStat(stat) ? (fired += 1, reborn(stat)) : stat);
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`(${tree} was replaced by another directory)`) });
    expect(fired, 'the recycled inode was seen').toBeGreaterThan(0);
  });

  it('names every directory now reached through a symlink', () => {
    const { root, tree, reference } = record();
    let armed = false;
    hooks.onOpen = (path) => { if (path.endsWith('.tar.gz')) armed = true; };
    hooks.onRealpath = (path, real) => (armed && (path === tree || path === root) ? `${real}-elsewhere` : real);
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: `the record directory or the original tree changed while it was being verified (${root} is now reached through a symlink; ${tree} is now reached through a symlink) — the tree is retained` });
  });

  it('refuses a directory swapped between its identity and its proof, before anything is read', () => {
    // The record directory: its identity, then a later stat shows another directory.
    const first = record();
    let seen = 0;
    hooks.onLstat = (path, stat) => (path === first.root && bigintStat(stat) && (seen += 1) > 1 ? reborn(stat) : stat);
    expect(resolvePreservationReference({ reference: first.reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: `the preservation record directory changed while it was being proven (${first.root} was replaced by another directory) — the tree is retained` });
    // The original tree, the same way.
    const second = record();
    seen = 0;
    hooks.onLstat = (path, stat) => (path === second.tree && bigintStat(stat) && (seen += 1) > 1 ? reborn(stat) : stat);
    expect(resolvePreservationReference({ reference: second.reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: `the original tree changed while it was being proven (${second.tree} was replaced by another directory) — the tree is retained` });
  });

  it('refuses a link parent swapped between two of its entries, and shows a record-named path safely', () => {
    const { root, tree, reference: original } = record();
    mkdirSync(join(tree, 'nested'));
    symlinkSync('../one', join(tree, 'nested', 'a'));
    symlinkSync('../two', join(tree, 'nested', 'b'));
    const manifest = JSON.stringify({ original_tree: tree, relative_entries: ['nested/a', 'nested/b'], archive_sha256: sha256('archive') });
    writeFileSync(join(root, 'link-preservation-manifest.json'), manifest);
    const text = JSON.stringify({
      job: { id: 'job-h1', repo: 'fixture-repo' }, tree: { job_id: 'job-h1', path: tree },
      original_report_sha256: sha256('r'), original_session_sha256: sha256('s'), link_manifest_sha256: sha256(manifest),
    });
    writeFileSync(original.recordPath, text);
    const reference = { recordPath: original.recordPath, recordSha256: sha256(text) };
    let seen = 0;
    hooks.onLstat = (path, stat) => (path === join(tree, 'nested') && bigintStat(stat) && (seen += 1) === 2 ? reborn(stat) : stat);
    expect(resolvePreservationReference({ reference, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: `the original tree changed while it was being verified (${join(tree, 'nested')} was replaced by another directory) — the tree is retained` });
    hooks.onLstat = null;
    // A tree whose name carries a bidi override is shown as a JSON literal.
    const odd = record();
    const oddTree = join(odd.root, 'tree\u202eevil');
    renameSync(odd.tree, oddTree);
    const oddManifest = JSON.stringify({ original_tree: oddTree, relative_entries: [], archive_sha256: sha256('archive') });
    writeFileSync(join(odd.root, 'link-preservation-manifest.json'), oddManifest);
    const oddText = JSON.stringify({
      job: { id: 'job-h1', repo: 'fixture-repo' }, tree: { job_id: 'job-h1', path: oddTree },
      original_report_sha256: sha256('r'), original_session_sha256: sha256('s'), link_manifest_sha256: sha256(oddManifest),
    });
    writeFileSync(odd.reference.recordPath, oddText);
    let armed = false;
    hooks.onOpen = (path) => { if (path.endsWith('.tar.gz')) armed = true; };
    hooks.onLstat = (path, stat) => (armed && path === oddTree && bigintStat(stat) ? reborn(stat) : stat);
    expect(resolvePreservationReference({ reference: { recordPath: odd.reference.recordPath, recordSha256: sha256(oddText) }, jobId: 'job-h1' }))
      .toMatchObject({ reusable: false, guidance: expect.stringContaining(`(${JSON.stringify(oddTree)} was replaced by another directory)`) });
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
