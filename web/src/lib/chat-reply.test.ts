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

  it('a sentence the tool work interrupted mid-way is joined exactly as written', () => {
    expect(resumeReplyText('Mock Gru ', 'here, boss!')).toBe('Mock Gru here, boss!');
    expect(resumeReplyText('I checked the file', ' and it is fine.')).toBe('I checked the file and it is fine.');
    expect(resumeReplyText('The count is 3', ', as expected.')).toBe('The count is 3, as expected.');
  });

  it('a finished sentence may close with quotes, brackets or emphasis and still gets its break', () => {
    for (const end of ['Done.', 'Done!', 'Really?', 'Here is what I found:', 'He said "done."', '(It works.)', '**Done.**', 'Wait…']) {
      expect(resumeReplyText(end, 'Next part.'), end).toBe(`${end}\n\nNext part.`);
    }
  });

  it('never glues text onto a markdown block: a closed code fence, a table row, a heading, a list item, a quote', () => {
    const fence = 'Here is the fix:\n```ts\nconst port = 7665;\n```';
    expect(resumeReplyText(fence, 'The tests pass.')).toBe(`${fence}\n\nThe tests pass.`);
    const table = '| check | result |\n| --- | --- |\n| lint | ok |';
    expect(resumeReplyText(table, 'Both rows match.')).toBe(`${table}\n\nBoth rows match.`);
    expect(resumeReplyText('## Plan', 'First I read the file.')).toBe('## Plan\n\nFirst I read the file.');
    expect(resumeReplyText('Steps:\n- read the file', 'Then I ran it.')).toBe('Steps:\n- read the file\n\nThen I ran it.');
    expect(resumeReplyText('1. read the file', 'then I ran it')).toBe('1. read the file\n\nthen I ran it');
    expect(resumeReplyText('> quoted line', 'My reply.')).toBe('> quoted line\n\nMy reply.');
  });

  it('starts a paragraph before text that opens a block of its own, even mid-sentence', () => {
    expect(resumeReplyText('The result', '| check | result |\n| --- | --- |')).toBe('The result\n\n| check | result |\n| --- | --- |');
    expect(resumeReplyText('What I found', '- the port is taken')).toBe('What I found\n\n- the port is taken');
    expect(resumeReplyText('The fix', '```ts\nconst a = 1;\n```')).toBe('The fix\n\n```ts\nconst a = 1;\n```');
    expect(resumeReplyText('Done', '## Next')).toBe('Done\n\n## Next');
  });

  it('text inside a code fence that is still open is joined as written: a blank line there is content', () => {
    const open = 'Running:\n```sh\nnpm test';
    expect(resumeReplyText(open, ' -- --watch')).toBe(`${open} -- --watch`);
    expect(resumeReplyText(`${open}.`, 'Then more.')).toBe(`${open}.Then more.`);
    // A tilde fence is closed only by a tilde fence.
    expect(resumeReplyText('~~~\ncode\n```', 'more')).toBe('~~~\ncode\n```more');
  });

  it('a finished-looking abbreviation followed by a continuation is not split', () => {
    expect(resumeReplyText('Check the config, e.g.', ' the port.')).toBe('Check the config, e.g. the port.');
    expect(resumeReplyText('It works on v2.', 'x and later.')).toBe('It works on v2.x and later.');
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
