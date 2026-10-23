import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabRepoOverviewApi } from '../src/repos/gitlab-overview.js';
import { RepoProviderError } from '../src/repos/overview.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(() => { throw new Error('test refuses unmocked child spawn; no live glab calls'); }) };
});

/** The production GitLab adapter's default runner (#480). It lives in its
 * own file so this child_process mock stays away from
 * repo-overview-gitlab.test.ts, whose real-git origin test spawns git. */
describe('GitLab overview default glab runner', () => {
  afterEach(() => {
    vi.useRealTimers();
    // Reset drops any unconsumed mockReturnValueOnce; the refusal default
    // is re-established so a stray spawn can never reach a real glab.
    vi.mocked(spawn).mockReset().mockImplementation(() => {
      throw new Error('test refuses unmocked child spawn; no live glab calls');
    });
  });

  it('spawns glab api --include for the host and kills the run at its 15 s bound', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    const pending = new GitLabRepoOverviewApi()
      .fetchProject({ repo: { host: 'gitlab.example.com', owner: 'group/sub', repo: 'project' } })
      .catch((caught: unknown) => caught);
    expect(spawn).toHaveBeenCalledWith(
      'glab',
      ['api', '--hostname', 'gitlab.example.com', '--include', 'projects/group%2Fsub%2Fproject'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    vi.advanceTimersByTime(14_999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const error = (await pending) as RepoProviderError;
    expect(error).toBeInstanceOf(RepoProviderError);
    expect(error.kind).toBe('other');
    expect(error.message).toBe('project group/sub/project on gitlab.example.com: glab api timed out after 15000 ms');
  });
});
