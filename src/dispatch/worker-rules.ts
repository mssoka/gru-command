import { PR_CREATION_RULE } from './pr-creation.js';
import { TOOL_CALL_POLICY } from './tool-call-policy.js';

/**
 * Stage-5 review convergence (issue #225) for review loops run inside
 * minion lanes (the bmad-review gate and any self-run review/fix cycle):
 * the same rule the Perkins host enforces, as playbook text. From the
 * third round of one review loop, a NEW finding holds the loop only when
 * its location intersects the hunks this round actually changed; new
 * findings on untouched code are filed as follow-ups (reported in the
 * loop's output, never dropped) and cannot trigger another round. Findings
 * already raised in earlier rounds whose quoted evidence is unchanged are
 * carried forward, not re-litigated from scratch. One final whole-review
 * pass at the READY candidate is the standing whole-change authority.
 */
export const REVIEW_CONVERGENCE_RULE = [
  'REVIEW CONVERGENCE RULE (review loops in minion lanes):',
  '- From round 3 of one review/fix loop, only a new finding whose location intersects the hunks changed in this round can block; new findings on untouched code are follow-ups — report them as such, never drop them, and do not run another round for them.',
  '- Prior findings whose quoted evidence is unchanged carry forward as still-present without re-verification; findings whose code changed, or that you claimed fixed, are re-verified explicitly.',
  '- A loop whose rounds review only the latest changes (delta-scoped) must run one final whole-review pass of the complete change at a READY/PASS candidate before it may report convergence. A loop that already reviews the complete change in every round (such as a working-diff gate) holds that whole-change coverage in the concluding round itself.',
].join('\n');

/**
 * Background processes (#486): a browser daemon, dev server or watcher a
 * minion starts and leaves running holds its lane's sweep. GC stops what
 * the lane's sessions leave behind once their turns end (each process
 * carries the lane's token), but the minion stopping its own is the first
 * line, and the only one for a process that drops its environment.
 */
export const BACKGROUND_PROCESS_RULE = [
  'BACKGROUND PROCESS RULE:',
  '- Stop every background process you start (browser daemons such as `agent-browser close`, local servers, watchers) before you end your turn.',
  '- GC stops what your commands leave running in the lane once your turn ends: never rely on a process outliving the turn that started it; start it again in the turn that needs it.',
].join('\n');

/**
 * PR media (owner rulings 2026-11-15, docs/PR-MEDIA.md): a minion whose change
 * is visible captures it from its committed head and submits each capture to
 * the service, which binds it to that head, shows it on the owner's FOR YOU
 * card and writes the PR description's media section. The service accepts a
 * capture only while the lane sits at exactly the named head with a clean
 * tracked tree: the record says which commit the capture was submitted at.
 */
export const PR_MEDIA_RULE = [
  'PR MEDIA RULE (screenshots and clips for the owner\'s review):',
  '- Applies only to work that changes something a person sees (a page, a component, a rendered output) in a contract that authorizes a pull request. Review, read-only and other non-publishing jobs submit nothing. When the repository\'s .gru-command/worktree.toml has a [capture] table, a diff touching its `paths` globs owes media or a skip reason, and the owner sees "media owed" on the PR when it has neither.',
  '- Direct the shots; GC films them. Write `shot-list.json` in your private operational artifacts folder (named in your workflow notes): {"version": 1, "shots": [{"id": "<a-z0-9->", "proves": "<the acceptance item it shows>", "kind": "screenshot" or "clip", "viewports": ["desktop", "mobile"] (or {"width": W, "height": H}), "steps": [{"open": "/path"}, {"click": "<css selector>"}, {"type": "<css selector>", "text": "<mock text>"}, {"wait_for_text": "<text>"}], "compare": "base" (only when your briefing asks for a before/after comparison)}]}. A shot that cannot be filmed gets {"id", "proves", "skip": "<why>"}; a change with nothing to see gets {"version": 1, "skip": "<why>"}. At most 8 files per head (shots × viewports, twice with compare).',
  '- GC starts the app with [capture] serve on a port it picks, waits for [capture] ready, and films the list at your committed head once you deliver it (or once the head has stood still), re-filming whenever the head or the list changes. Read the outcome with GET /api/media?job_id=<your job id> (`camera`: started, filmed, or failed with a `code` and `detail`; `coverage`: owed, skipped or covered): a failed step means fix the selector, the text or the code, and the list is filmed again.',
  '- Fallback, when the repository has no [capture] serve or the output is not a web page: capture it yourself from your committed head (for example `agent-browser screenshot`, or `agent-browser record start <file>.webm` then `record stop`) and submit each file with POST /api/media to the service (its address and `[auth]` token are in its instance config, as for POST /api/dispatch). Write the JSON body {"job_id": "<your job id>", "head_sha": "<your lane\'s full HEAD sha>", "caption": "<one line: what it shows>", "role": "after" or "before", "content_base64": "<the file, base64>"} to a file outside your worktree and send it with `curl --data-binary @<file>`. It is refused unless your lane sits at exactly that head with no uncommitted tracked changes; `pr_media_disabled` means skip media. PNG, JPEG, GIF, WebP, WebM or MP4; at most 10 MB each.',
  '- GC binds each capture to its head, shows it to the owner on the FOR YOU card and writes the PR description\'s media section. Never attach media to the PR yourself, never commit captures or the shot list into the repository, keep capture files outside your worktree, and keep the description\'s gc-media section intact when you edit the description.',
  '- Shots show mock or seed data only: never real accounts, credentials, tokens or personal data, and never text typed from a real secret.',
].join('\n');

/**
 * The complete set of current rule blocks an assembled worker instruction
 * carries. Rendering and appending live here (one ordered list, one append
 * helper DERIVED from it) so briefings, re-briefs and follow-up directives
 * cannot drift apart block by block.
 */
export const WORKER_RULE_BLOCKS: readonly string[] = [PR_CREATION_RULE, TOOL_CALL_POLICY, REVIEW_CONVERGENCE_RULE, BACKGROUND_PROCESS_RULE, PR_MEDIA_RULE];

/** Append every current worker rule block to an authored instruction text
 * (one blank line between blocks, always). Derived from the ordered list so
 * adding or reordering a block cannot leave one instruction path behind. */
export function appendWorkerRules(text: string): string {
  return `${text}\n\n${WORKER_RULE_BLOCKS.join('\n\n')}`;
}

/** A review job's closing standing orders (E19): its deliverable is its
 * findings, so it commits nothing. One list for a reviewer's dispatch
 * briefing, re-brief and fresh directive session, so a reviewer is never
 * told to commit. */
export const READ_ONLY_REVIEW_ORDERS: readonly string[] = [
  'Execute the briefing inside this worktree. Standing orders: work only',
  'inside this tree; this brief is READ-ONLY — change nothing, commit',
  'nothing (an unmodified tree is the expected result); read the named',
  'immutable head and diff via git show/git diff inside your tree; never',
  'merge; end with your findings and a completion report.',
];
