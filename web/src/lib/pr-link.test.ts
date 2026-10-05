import { describe, expect, it } from 'vitest';
import { prLinkLabel, prNumberFromUrl } from './pr-link.js';

/**
 * Deterministic contract for the per-heist PR link label (j-982): the
 * number comes from the canonical request route only, never from a
 * hostname/query/fragment, and unprovable URLs keep the generic label.
 */
describe('pr link labelling', () => {
  it('reads the request number from GitHub /pull/ routes', () => {
    expect(prLinkLabel('https://github.com/acme/web/pull/138')).toBe('PR #138 ↗');
    expect(prNumberFromUrl('https://github.com/acme/web/pull/7')).toBe('7');
    // Host case and long owner/repo names are still the same route.
    expect(prLinkLabel('https://GitHub.com/acme-org/web.app/pull/12')).toBe('PR #12 ↗');
    expect(prLinkLabel('https://foo.github/acme/web/pull/3')).toBe('PR #3 ↗');
  });

  it('reads the request number from GitLab /-/merge_requests/ routes', () => {
    expect(prLinkLabel('https://gitlab.com/group/web/-/merge_requests/42')).toBe('PR #42 ↗');
    expect(prLinkLabel('https://gitlab.example.test/group/sub/web/-/merge_requests/42')).toBe(
      'PR #42 ↗',
    );
  });

  it('tolerates trailing slash, query and fragment without reading them for digits', () => {
    expect(prLinkLabel('https://github.com/acme/web/pull/138/')).toBe('PR #138 ↗');
    expect(prLinkLabel('https://github.com/acme/web/pull/138?diff=split')).toBe('PR #138 ↗');
    expect(prLinkLabel('https://github.com/acme/web/pull/138#discussion_r99')).toBe('PR #138 ↗');
    expect(prLinkLabel('https://gitlab.com/group/web/-/merge_requests/42/')).toBe('PR #42 ↗');
    expect(prLinkLabel('https://gitlab.com/group/web/-/merge_requests/42?tab=commits#note_7')).toBe(
      'PR #42 ↗',
    );
    // The canonical route number wins; query/fragment digits are ignored.
    expect(prNumberFromUrl('https://github.com/acme/web/pull/5?other=777#888')).toBe('5');
  });

  it('keeps large identifiers as exact text (no Number rounding)', () => {
    expect(prNumberFromUrl('https://github.com/acme/web/pull/9007199254740993')).toBe(
      '9007199254740993',
    );
    expect(prLinkLabel('https://github.com/acme/web/pull/123456789012345678901234567890')).toBe(
      'PR #123456789012345678901234567890 ↗',
    );
  });

  it('stays generic for non-request routes on recognized hosts', () => {
    // Issues, pull listings, and subviews of a request are not the
    // canonical request route.
    for (const url of [
      'https://github.com/acme/web/issues/138',
      'https://github.com/acme/web/pulls/138',
      'https://github.com/acme/web/pull/138/files',
      'https://github.com/acme/web/pull/abc',
      'https://gitlab.com/group/web/-/merge_requests/42/diffs',
      'https://gitlab.com/group/web/-/merge_requests/not-a-number',
    ]) {
      expect(prLinkLabel(url)).toBe('PR ↗');
      expect(prNumberFromUrl(url)).toBeNull();
    }
  });

  it('stays generic for unproven hosts, non-https schemes, and malformed input', () => {
    for (const url of [
      // Unrelated host (the dev mock placeholder), lookalikes, and
      // GitLab-shaped hosts whose first label is not exactly `gitlab`.
      'https://example.invalid/pr/43',
      'https://evil-github.com/acme/web/pull/5',
      'https://github.com.attacker.test/acme/web/pull/5',
      'https://evil.gitlab.attacker.test/group/web/-/merge_requests/5',
      'https://mygitlab.example.com/group/web/-/merge_requests/5',
      // Scheme and credential shapes never yield a trusted number.
      'http://github.com/acme/web/pull/5',
      'ftp://github.com/acme/web/pull/5',
      'https://token@github.com/acme/web/pull/5',
      // Malformed / empty input.
      'not a url',
      '',
    ]) {
      expect(prLinkLabel(url)).toBe('PR ↗');
      expect(prNumberFromUrl(url)).toBeNull();
    }
  });
});
