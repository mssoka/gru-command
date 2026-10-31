#!/usr/bin/env node
// Reviewer-visible text check for #520 (contract revision 1: commit and PR
// text). Commit messages, the PR title and the PR body are output a blind
// reviewer reads, so none of them may read as a grep hit of an excluded path
// under the rule the acceptance tests use. This applies `scanObservedAccess`
// to the branch's own commit messages and to the PR text kept in
// `gru-output/gc-520/pr-body.md`, prints counts only, and exits non-zero on
// any hit.
//
//   node gru-output/gc-520/msg-check.mjs
//
// Nothing here prints the matching text: that text is exactly what must not
// ride a reviewer-visible surface, so the report names the surface and the
// number of hits, never the line. Runs through the `gc-520-msg-check` verify
// scope; the declared base is the merge base with `origin/main` at the final
// head.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const print = (line) => process.stdout.write(`${line}\n`);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

const PR_TEXT = 'gru-output/gc-520/pr-body.md';
const scratch = mkdtempSync(join(tmpdir(), 'gc-520-msg-check.'));
try {
  // The scanner is TypeScript; bundle it the way the repository's own tools
  // consume it, from the checked-out head, with no network and no install.
  const bundle = join(scratch, 'blind-input.mjs');
  execFileSync(join(root, 'node_modules', '.bin', 'esbuild'), [
    join(root, 'src', 'dispatch', 'blind-input.ts'),
    '--bundle', '--format=esm', '--platform=node', '--log-level=error', `--outfile=${bundle}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const { DEFAULT_BLIND_ISOLATION_RULE: rule, scanObservedAccess } = await import(pathToFileURL(bundle).href);

  const base = git('merge-base', 'origin/main', 'HEAD').trim();
  const messages = git('log', '--format=%B', `${base}..HEAD`);
  const prText = readFileSync(join(root, PR_TEXT), 'utf8');

  // The same shapes a reviewer's tools put the text in: the text itself, a
  // numbered gutter (`cat -n`, a read tool) and a diff (`+line`).
  const shapes = (label, text) => {
    const lines = text.split('\n');
    return [
      { surface: label, text },
      { surface: `${label}, numbered`, text: lines.map((line, index) => `${index + 1}\t${line}`).join('\n') },
      { surface: `${label}, as a diff`, text: lines.map((line) => `+${line}`).join('\n') },
    ];
  };
  const surfaces = [
    ...shapes(`${messages.split('\n').length} lines of commit messages (${base.slice(0, 12)}..HEAD)`, messages),
    ...shapes(`the PR text (${PR_TEXT}, ${prText.split('\n').length} lines)`, prText),
  ];

  const failed = surfaces
    .map(({ surface, text }) => ({ surface, hits: scanObservedAccess([{ index: 0, toolName: 'bash', text }], rule).length }))
    .filter(({ hits }) => hits > 0);
  print(`msg-check base=${base} head=${git('rev-parse', 'HEAD').trim()} surfaces=${surfaces.length}`);
  for (const { surface, hits } of failed) print(`HIT ${hits}: ${surface}`);
  if (failed.length > 0) {
    print('FAILED: reviewer-visible text reads as a hit of an excluded path');
    process.exitCode = 1;
  } else {
    print(`PASS: 0 hits over ${surfaces.length} surfaces (${messages.length} bytes of messages, ${prText.length} bytes of PR text)`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
