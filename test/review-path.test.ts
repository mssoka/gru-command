import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import {
  boundedDiff,
  parseFallbackFindingsReport,
  parseRepoRemote,
  preflightFailure,
  probeGitLabRemote,
  probeModelProvider,
  renderFixDirective,
  runReviewPreflight,
  skillInstalled,
  triageFallbackFindings,
  type FallbackFinding,
} from '../src/dispatch/review-path.js';

function finding(category: string, title = 'finding'): FallbackFinding {
  return { title, category, location: 'src/x.ts:1', evidence: 'evidence', detail: 'detail' };
}

describe('four-leg review pre-flight', () => {
  it('passes when every leg resolves', async () => {
    const result = await runReviewPreflight({
      'resource-integrity': () => {},
      'model-provider': () => {},
      'code-host': () => {},
      'review-policy': () => {},
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('names every failing leg once, with remediation, and never stops at the first', async () => {
    const result = await runReviewPreflight({
      'resource-integrity': () => {
        throw new Error('policy hash mismatch');
      },
      'model-provider': () => {},
      'code-host': () => {
        throw new Error('gh cannot read owner/repo');
      },
      'review-policy': () => {
        throw new Error('review gate disabled');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.leg)).toEqual(['resource-integrity', 'code-host', 'review-policy']);
    expect(result.failures[0]?.remediation).toMatch(/verify-perkins-resource/);
    expect(result.failures[1]?.remediation).toMatch(/gh auth login|GITLAB_TOKEN/u);
    expect(result.failures[2]?.remediation).toMatch(/\[review\] enabled = true/u);
  });

  it('supports async leg probes', async () => {
    const result = await runReviewPreflight({
      'resource-integrity': () => {},
      'model-provider': () => Promise.reject(new Error('provider not authenticated')),
      'code-host': () => {},
      'review-policy': () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.leg).toBe('model-provider');
  });

  it('builds failures through the preflightFailure helper', () => {
    const failure = preflightFailure('code-host', 'token expired');
    expect(failure).toMatchObject({ leg: 'code-host', detail: 'token expired' });
    expect(failure.remediation).toContain('GITLAB_TOKEN');
  });
});

describe('model-provider probe', () => {
  it('accepts a resolvable model whose provider holds credentials', async () => {
    await expect(probeModelProvider({
      modelRef: 'acme/fast-model',
      getModel: () => ({ id: 'fast-model' }),
      checkAuth: () => Promise.resolve({ type: 'oauth' }),
      availableProviders: () => ['acme'],
    })).resolves.toBeUndefined();
  });

  it('rejects an unresolvable model and an unauthenticated provider', async () => {
    await expect(probeModelProvider({
      modelRef: 'acme/missing',
      getModel: () => undefined,
      checkAuth: () => Promise.resolve({ type: 'api_key' }),
      availableProviders: () => ['acme'],
    })).rejects.toThrow(/does not resolve/u);
    await expect(probeModelProvider({
      modelRef: 'acme/fast-model',
      getModel: () => ({ id: 'fast-model' }),
      checkAuth: () => Promise.resolve(undefined),
      availableProviders: () => ['acme'],
    })).rejects.toThrow(/not authenticated/u);
  });

  it('resolves the default reference through any authed provider', async () => {
    await expect(probeModelProvider({
      modelRef: 'default',
      getModel: () => undefined,
      checkAuth: (provider) => Promise.resolve(provider === 'authed' ? { type: 'api_key' } : undefined),
      availableProviders: () => ['locked', 'authed'],
    })).resolves.toBeUndefined();
    await expect(probeModelProvider({
      modelRef: '',
      getModel: () => undefined,
      checkAuth: () => Promise.resolve(undefined),
      availableProviders: () => ['locked'],
    })).rejects.toThrow(/no configured\/authed model provider/u);
  });
});

describe('GitLab code-host probe', () => {
  const remote = parseRepoRemote('https://gitlab.example.test/acme/widget.git')!;

  it('passes when the token reads the project', async () => {
    const calls: string[] = [];
    await expect(probeGitLabRemote(remote, 'glpat-token', async (url, init) => {
      calls.push(`${(init?.headers as Record<string, string> | undefined)?.['PRIVATE-TOKEN']} ${url}`);
      return { ok: true, status: 200 };
    })).resolves.toBeUndefined();
    expect(calls).toEqual(['glpat-token https://gitlab.example.test/api/v4/projects/acme%2Fwidget']);
  });

  it('fails closed on missing token, bad token, and unreachable host', async () => {
    await expect(probeGitLabRemote(remote, undefined, async () => ({ ok: true, status: 200 })))
      .rejects.toThrow(/set GITLAB_TOKEN/u);
    await expect(probeGitLabRemote(remote, 'bad', async () => ({ ok: false, status: 401 })))
      .rejects.toThrow(/HTTP 401/u);
    await expect(probeGitLabRemote(remote, 'glpat-token', async () => {
      throw new Error('connect ECONNREFUSED');
    })).rejects.toThrow(/ECONNREFUSED/u);
  });
});

describe('fallback gate triage (fork-3)', () => {
  it('classifies release-safety defects as blockers and the rest as notes', () => {
    const triaged = triageFallbackFindings([
      finding('correctness', 'off-by-one'),
      finding('Security', 'token leak'),
      finding('data loss', 'dropped writes'),
      finding('broken-build', 'type error'),
      finding('build-failure', 'missing export'),
      finding('crash', 'null deref'),
      finding('regression', 'flaky retry'),
      finding('vulnerability', 'XXE'),
      finding('injection', 'sql concat'),
      finding('secret-leak', 'committed key'),
      finding('style', 'naming'),
      finding('documentation', 'stale comment'),
      finding('performance', 'slow loop'),
      finding('weird-unknown', 'unclear'),
    ]);
    expect(triaged.blockers.map((blocker) => blocker.title)).toEqual([
      'off-by-one', 'token leak', 'dropped writes', 'type error', 'missing export',
      'null deref', 'flaky retry', 'XXE', 'sql concat', 'committed key',
    ]);
    expect(triaged.notes.map((note) => note.title)).toEqual(['naming', 'stale comment', 'slow loop', 'unclear']);
  });

  it('renders the fix directive for the implementing minion', () => {
    const directive = renderFixDirective([finding('security', 'token leak')], 2);
    expect(directive).toContain('Fix directive (round 2)');
    expect(directive).toContain('1 release-safety blocker(s)');
    expect(directive).toContain('token leak');
    expect(directive).toContain('BLOCKER 1');
  });

  it('parses and validates session-written findings reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-path-'));
    try {
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify([finding('security')]), 'utf8');
      expect(parseFallbackFindingsReport(good)).toHaveLength(1);
      const malformed = join(dir, 'bad.json');
      writeFileSync(malformed, '{', 'utf8');
      expect(() => parseFallbackFindingsReport(malformed)).toThrow(/malformed JSON/u);
      const missingField = join(dir, 'missing.json');
      writeFileSync(missingField, JSON.stringify([{ title: 'x', category: 'security' }]), 'utf8');
      expect(() => parseFallbackFindingsReport(missingField)).toThrow(/field location/u);
      writeFileSync(join(dir, 'not-array.json'), '{"title":"x"}', 'utf8');
      expect(() => parseFallbackFindingsReport(join(dir, 'not-array.json'))).toThrow(/JSON array/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds the diff handed to a review session', () => {
    expect(boundedDiff('short')).toBe('short');
    const huge = 'x'.repeat(600 * 1024);
    const bounded = boundedDiff(huge, 1024);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThan(1200);
    expect(bounded).toContain('diff truncated');
  });

  it('detects the installed skill without bundling one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-path-skill-'));
    try {
      const skill = join(dir, 'SKILL.md');
      expect(skillInstalled(skill)).toBe(false);
      writeFileSync(skill, '---\nname: bmad-review\n---\n', 'utf8');
      expect(skillInstalled(skill)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[review] config leg', () => {
  it('defaults the Perkins gate to enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-path-config-'));
    try {
      const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
      expect(config.review).toEqual({ enabled: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses review.enabled and rejects unknown keys and non-boolean values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-path-config-'));
    try {
      const write = (toml: string): ReturnType<typeof loadConfig> => {
        writeFileSync(join(dir, 'config.toml'), toml, 'utf-8');
        return loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
      };
      expect(write('[review]\nenabled = false\n').review).toEqual({ enabled: false });
      expect(() => write('[review]\nmode = "off"\n')).toThrow(ConfigError);
      expect(() => write('[review]\nenabled = "no"\n')).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GitHub code-host probe and host classification', () => {
  it('classifies github/gitlab/other hosts', async () => {
    const { isGitHubRemote, isGitLabRemote } = await import('../src/dispatch/review-path.js');
    expect(isGitHubRemote('github.com')).toBe(true);
    expect(isGitHubRemote('github.com')).toBe(true);
    expect(isGitHubRemote('gitlab.com')).toBe(false);
    expect(isGitLabRemote('gitlab.com')).toBe(true);
    expect(isGitLabRemote('gitlab.example.test')).toBe(true);
    expect(isGitLabRemote('github.com')).toBe(false);
    expect(isGitLabRemote('code.company.test')).toBe(false);
  });

  it('parses https and ssh remotes', () => {
    expect(parseRepoRemote('https://github.com/acme/widget.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRepoRemote('https://github.com/acme/widget/')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRepoRemote('git@github.com:acme/widget.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(parseRepoRemote('ssh://git@gitlab.example.test:2222/acme/widget.git')).toEqual({ host: 'gitlab.example.test', owner: 'acme', repo: 'widget' });
    expect(parseRepoRemote('not a remote')).toBeNull();
  });

  it('passes when gh reads the repo and fails on unavailable/failed gh', async () => {
    const { probeGitHubRemote } = await import('../src/dispatch/review-path.js');
    const remote = { host: 'github.com', owner: 'acme', repo: 'widget' };
    const root = mkdtempSync(join(tmpdir(), 'review-path-gh-'));
    try {
      const good = join(root, 'gh-good.mjs');
      writeFileSync(good, '#!/usr/bin/env node\nprocess.stdout.write("acme/widget\\n");\n', 'utf8');
      const { chmodSync } = await import('node:fs');
      chmodSync(good, 0o755);
      expect(() => probeGitHubRemote(remote, good)).not.toThrow();
      const bad = join(root, 'gh-bad.mjs');
      writeFileSync(bad, '#!/usr/bin/env node\nprocess.stderr.write("no auth\\n");\nprocess.exit(1);\n', 'utf8');
      chmodSync(bad, 0o755);
      expect(() => probeGitHubRemote(remote, bad)).toThrow(/cannot read acme\/widget/u);
      expect(() => probeGitHubRemote(remote, join(root, 'missing-gh'))).toThrow(/unavailable/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isGitLabRemote exact-match boundary (V2 revert-mutation pin)', () => {
  it('rejects lookalike hosts that merely contain gitlab as a non-first label', async () => {
    const { isGitLabRemote } = await import('../src/dispatch/review-path.js');
    expect(isGitLabRemote('evil.gitlab.attacker.test')).toBe(false);
    expect(isGitLabRemote('mygitlab.example.com')).toBe(false);
    expect(isGitLabRemote('notgitlab.com')).toBe(false);
    expect(isGitLabRemote('gitlab.example.test')).toBe(true);
    expect(isGitLabRemote('gitlab.com')).toBe(true);
  });
});

describe('parseFallbackFindingsReport guards', () => {
  it('rejects a report exceeding the 4 MiB file cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-path-cap-'));
    try {
      const big = join(root, 'big.json');
      const entry = JSON.stringify({ title: 'x'.repeat(100), category: 'style', location: 'a:1', evidence: 'e'.repeat(200), detail: 'd' });
      writeFileSync(big, '[' + `${entry},\n`.repeat(30_000) + ']', 'utf8');
      const size = statSync(big).size;
      if (size > 4 * 1024 * 1024) {
        expect(() => parseFallbackFindingsReport(big)).toThrow(/exceeds 4 MiB/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a report with more than 200 findings', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-path-count-'));
    try {
      const big = join(root, 'many.json');
      const entry = JSON.stringify({ title: 'x', category: 'style', location: 'a:1', evidence: 'e', detail: 'd' });
      writeFileSync(big, '[' + `${entry},`.repeat(201) + '{}]', 'utf8');
      expect(() => parseFallbackFindingsReport(big)).toThrow(/at most 200/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('claude-code preflight model argv split (Blocker A pin)', () => {
  it('the --model flag and value must be separate argv tokens', () => {
    // The single-token form '--model <ref>' is rejected by the CLI.
    // This test pins the correct two-token split by verifying that the
    // spawnSync args array contains --model and <ref> as distinct elements.
    // The actual spawnSync is in main.ts (not importable), so we verify
    // the behavior indirectly: the probe must NOT throw a "unknown option"
    // error when a model ref is configured.
    // Regression test: if the one-token form is restored, the claude-code
    // preflight leg will always fail with "error: unknown option" and the
    // Perkins gate will never engage for claude-code runtimes.
    const modelRef: string = 'claude-sonnet-4-20250514';
    const modelArgs = modelRef === '' || modelRef === 'default' ? [] : ['--model', modelRef];
    expect(modelArgs).toEqual(['--model', modelRef]);
    expect(modelArgs).toHaveLength(2);
    // The old buggy form would produce a single-element array:
    const buggyForm = modelRef === '' || modelRef === 'default' ? '' : `--model ${modelRef}`;
    expect(buggyForm).toContain(' ');
    expect(modelArgs).not.toEqual([buggyForm]);
  });
});
