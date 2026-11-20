import { describe, expect, it } from 'vitest';
import { LONG_REPLY_CHARS, LONG_REPLY_LINES, isLongReply, resumeReplyText } from './chat-reply.js';

describe('a reply that resumes after tool work', () => {
  it('starts its own paragraph instead of running into the sentence before it', () => {
    expect(resumeReplyText('Let me look before suggesting anything.', 'My local copy is behind.')).toBe(
      'Let me look before suggesting anything.\n\nMy local copy is behind.',
    );
    // A trailing space is not a break: the parts would still touch.
    expect(resumeReplyText('First part. ', 'Second part.')).toBe('First part. \n\nSecond part.');
  });

  it('leaves a break that either side already carries, and an empty side, alone', () => {
    expect(resumeReplyText('First part.\n', 'Second part.')).toBe('First part.\nSecond part.');
    expect(resumeReplyText('First part.\n\n', 'Second part.')).toBe('First part.\n\nSecond part.');
    expect(resumeReplyText('First part.', '\nSecond part.')).toBe('First part.\nSecond part.');
    expect(resumeReplyText('First part.', '  \n\nSecond part.')).toBe('First part.  \n\nSecond part.');
    expect(resumeReplyText('', 'Only part.')).toBe('Only part.');
    expect(resumeReplyText('  ', 'Only part.')).toBe('  Only part.');
    expect(resumeReplyText('First part.', '')).toBe('First part.');
  });
});

describe('a long reply', () => {
  it('is one longer than about six lines, by length or by written lines', () => {
    expect(isLongReply('Yes. Let me look at how it is built first.')).toBe(false);
    expect(isLongReply('x'.repeat(LONG_REPLY_CHARS))).toBe(false);
    expect(isLongReply('x'.repeat(LONG_REPLY_CHARS + 1))).toBe(true);
    const lines = (count: number): string => Array.from({ length: count }, (_, index) => `- point ${index + 1}`).join('\n');
    expect(isLongReply(lines(LONG_REPLY_LINES))).toBe(false);
    expect(isLongReply(lines(LONG_REPLY_LINES + 1))).toBe(true);
    // Blank lines and outer whitespace are not content.
    expect(isLongReply(`\n\n${lines(LONG_REPLY_LINES).replaceAll('\n', '\n\n')}\n\n`)).toBe(false);
    expect(isLongReply(`${' '.repeat(LONG_REPLY_CHARS)}short`)).toBe(false);
  });
});
