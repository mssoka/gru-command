import { execFile, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  groupHasLiveMember,
  groupHasLiveMemberAsync,
  OWNED_GIT_SEAMS,
} from '../src/dispatch/perkins-review/artifacts.js';

/**
 * The `ps` half of owned-group liveness (#511), proved BY CONSTRUCTION.
 *
 * `groupHasLiveMember` answers live when its `ps` run fails (non-zero status,
 * or no string to read) and reads the table when it succeeds; the async
 * reader answers live when its `execFile` rejects. The real binary is
 * exercised by the rest of the suite (`perkins-admission-preflight`), so this
 * file stubs `node:child_process` — file-scoped: a Vitest mock never leaves
 * the file — and pins both outcomes against the stub. No deadline, spawn
 * latency or host process table decides which branch runs, so inverting the
 * failure branch fails these cases and nothing here can go red on a host
 * where the production code is right.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Every listing in this file is stubbed before use: an unstubbed call is
    // a test bug, and it fails loudly instead of reading the host.
    spawnSync: vi.fn(() => {
      throw new Error('this file stubs every ps listing');
    }),
    execFile: vi.fn(() => {
      throw new Error('this file stubs every ps listing');
    }),
  };
});

/** Above every platform's pid_max: provably no live process shares it. */
const ABSENT_GROUP = 2_000_000_001;
const CLEAN_TABLE = '  10    10 Ss\n  11    99 Z\n';
const OUR_MEMBER = `  10    10 Ss\n  41001  ${ABSENT_GROUP} S\n`;

/** What one `spawnSync` listing returned: a failure carries no stdout. */
const listing = (status: number | null, stdout: string | null): { readonly status: number | null; readonly stdout: string | null } => ({ status, stdout });

/** The async reader's listing completed: `execFile` reports its stdout. */
const completesWith = (stdout: string): void => {
  vi.mocked(execFile).mockImplementation(((...args: readonly unknown[]) => {
    const done = args.at(-1) as (error: NodeJS.ErrnoException | null, result?: { readonly stdout: string; readonly stderr: string }) => void;
    done(null, { stdout, stderr: '' });
    return { pid: 0 };
  }) as unknown as typeof execFile);
};

/** The async reader's listing failed: `execFile` rejects like a killed child. */
const failsWith = (code: string): void => {
  vi.mocked(execFile).mockImplementation(((...args: readonly unknown[]) => {
    const done = args.at(-1) as (error: NodeJS.ErrnoException | null) => void;
    done(Object.assign(new Error(`${code}: the ps run did not complete`), { code }));
    return { pid: 0 };
  }) as unknown as typeof execFile);
};

/** The caller's group EXISTS (whatever its members) and the ps reader runs:
 * the answer under test is the listing branch's, never `groupExists`'s, and
 * the untouched Linux /proc reader never answers instead. */
const observingThePsBranch = async (body: () => Promise<void> | void): Promise<void> => {
  const existence = vi.spyOn(process, 'kill').mockReturnValue(true);
  const realPlatform = OWNED_GIT_SEAMS.platform;
  OWNED_GIT_SEAMS.platform = 'darwin';
  try {
    await body();
  } finally {
    OWNED_GIT_SEAMS.platform = realPlatform;
    existence.mockRestore();
  }
};

describe('owned-group liveness over ps (#511)', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(execFile).mockReset();
  });

  it('a ps run that fails is live — a stubbed failure, sync and async', async () => {
    await observingThePsBranch(async () => {
      vi.mocked(spawnSync).mockReturnValue(listing(null, '') as never);
      failsWith('ETIMEDOUT');
      expect(groupHasLiveMember(ABSENT_GROUP, 0)).toBe(true);
      // The async reader runs its OWN listing (`execFile`), never the sync one.
      expect(execFile).not.toHaveBeenCalled();
      await expect(groupHasLiveMemberAsync(ABSENT_GROUP, 0)).resolves.toBe(true);
      expect(execFile).toHaveBeenCalled();
      // The other half of the same guard: a run that reported success with
      // nothing to read is unknown too.
      vi.mocked(spawnSync).mockReturnValue(listing(0, null) as never);
      expect(groupHasLiveMember(ABSENT_GROUP, 0)).toBe(true);
    });
  });

  it('a ps run that succeeds with no rows for our group is stopped, sync and async', async () => {
    await observingThePsBranch(async () => {
      vi.mocked(spawnSync).mockReturnValue(listing(0, CLEAN_TABLE) as never);
      completesWith(CLEAN_TABLE);
      expect(groupHasLiveMember(ABSENT_GROUP, 5_000)).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
      await expect(groupHasLiveMemberAsync(ABSENT_GROUP, 5_000)).resolves.toBe(false);
      expect(execFile).toHaveBeenCalled();
    });
  });

  it('a ps run that succeeds and lists one of ours is live, sync and async', async () => {
    await observingThePsBranch(async () => {
      vi.mocked(spawnSync).mockReturnValue(listing(0, OUR_MEMBER) as never);
      completesWith(OUR_MEMBER);
      expect(groupHasLiveMember(ABSENT_GROUP, 5_000)).toBe(true);
      expect(execFile).not.toHaveBeenCalled();
      await expect(groupHasLiveMemberAsync(ABSENT_GROUP, 5_000)).resolves.toBe(true);
      expect(execFile).toHaveBeenCalled();
    });
  });
});
