import { describe, expect, it } from 'vitest';
import { appendLessonPointers, matchReferences, renderLessonsSection, renderPointerLine, taskTerms } from '../src/lessons/references.js';
import type { BibleChapter, LessonIndexEntry } from '../src/lessons/types.js';

/**
 * Reference matching (Book of Lessons): deterministic keyword scoring
 * against the index + chapter metadata; pointer lines carry location and
 * reason only. No embeddings, no chapter bodies.
 */

const INDEX: LessonIndexEntry[] = [
  { slug: 'ops-restarts', summary: 'Restart discipline for the hosted service.', tags: ['ops', 'restarts'] },
  { slug: 'worktrees', summary: 'Lane hygiene and sweep policy.', tags: ['worktrees', 'git'] },
];

const CHAPTERS: BibleChapter[] = [
  {
    slug: 'ops-restarts',
    title: 'Ops restarts',
    summary: 'Restart discipline for the hosted service.',
    tags: ['ops', 'restarts'],
    lessons: [
      {
        slug: 'shell-hang',
        body: 'Kill the shell before restarting. SECRET BODY CONTENT.',
        recurred: 2,
        provenance: [{ id: 'j-1', ts: '2026-09-23T00:00:00.000Z' }],
        tags: ['shell', 'hang'],
      },
      {
        slug: 'sweep-first',
        body: 'Sweep the lane only after preserving.',
        recurred: 1,
        provenance: [{ id: 'j-2', ts: '2026-09-24T00:00:00.000Z' }],
        tags: ['sweep'],
      },
    ],
  },
  {
    slug: 'worktrees',
    title: 'Worktrees',
    summary: 'Lane hygiene and sweep policy.',
    tags: ['worktrees', 'git'],
    lessons: [
      {
        slug: 'preserve-first',
        body: 'Preserve untracked deliverables before sweeping.',
        recurred: 1,
        provenance: [{ id: 'j-3', ts: '2026-09-25T00:00:00.000Z' }],
        tags: ['sweep', 'preserve'],
      },
    ],
  },
];

describe('lesson reference matching', () => {
  it('prefers a lesson-anchor match and explains why with the matched terms', () => {
    const pointers = matchReferences({
      index: INDEX,
      chapters: CHAPTERS,
      taskText: 'the shell hang keeps the restart failing',
      bibleDir: '/tmp/bible',
      max: 3,
    });
    expect(pointers[0]).toMatchObject({
      chapter: 'ops-restarts',
      lesson: 'shell-hang',
      path: '/tmp/bible/chapters/ops-restarts.md',
    });
    expect(pointers[0]!.why).toContain('task mentions');
    expect(pointers[0]!.why).toContain('shell');
    expect(pointers[0]!.why).toContain('hang');
  });

  it('falls back to chapter pointers when only index metadata matches', () => {
    const pointers = matchReferences({
      index: INDEX,
      taskText: 'worktrees need lane hygiene',
      bibleDir: '/tmp/bible',
      max: 3,
    });
    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toMatchObject({
      chapter: 'worktrees',
      lesson: null,
      path: '/tmp/bible/chapters/worktrees.md',
    });
    expect(pointers[0]!.why).toContain('worktree');
  });

  it('returns no pointers for an unrelated task and honors the max cap', () => {
    expect(
      matchReferences({ index: INDEX, chapters: CHAPTERS, taskText: 'write a poem', bibleDir: '/tmp/bible' }),
    ).toEqual([]);
    const pointers = matchReferences({
      index: INDEX,
      chapters: CHAPTERS,
      taskText: 'restart the shell and sweep the worktree lanes',
      bibleDir: '/tmp/bible',
      max: 2,
    });
    expect(pointers).toHaveLength(2);
  });

  it('renders pointer lines and sections without any chapter body', () => {
    const pointer = {
      chapter: 'ops-restarts',
      lesson: 'shell-hang',
      path: '/tmp/bible/chapters/ops-restarts.md',
      why: 'task mentions restart',
    };
    expect(renderPointerLine(pointer)).toBe(
      '- read /tmp/bible/chapters/ops-restarts.md#shell-hang (why: task mentions restart)',
    );
    const section = renderLessonsSection([pointer]);
    expect(section).toContain('RELEVANT LESSONS');
    expect(section).toContain('- read /tmp/bible/chapters/ops-restarts.md#shell-hang');
    expect(section).not.toContain('SECRET BODY CONTENT');
    expect(renderLessonsSection([])).toBe('');
    expect(appendLessonPointers('directive text', [])).toBe('directive text');
    expect(appendLessonPointers('directive text', [pointer])).toContain('directive text\n\nRELEVANT LESSONS');
  });

  it('stems plural keywords so a task phrase matches lesson tags', () => {
    expect(taskTerms('Restarting the services')).toContain('restart');
    expect(taskTerms('Restarting the services')).toContain('service');
  });
});
