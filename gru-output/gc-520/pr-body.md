<!-- title: fix: read the forms git grep prints for revisions and context lines in blind access observation (#520) -->
Refs #520
Supersedes #528

## What

Blind-review access observation now recognizes grep hits from excluded paths in the forms `git grep` really prints, so such a read invalidates blind isolation:

- against a revision: the revision, then the repository path, then the line number, for a match line and a context line;
- against a revision and a directory (the directory and file joined), and the tree root (a revision followed by two colons);
- a worktree context line (the path, a hyphen, the line number, a hyphen).

For every line whose own grammar settles where its path ends, the recorded `path` is the repository path and nothing else: no revision, no line number and no fragment of the matched or context text, so re-submitting the same tool result records the same read identity. A worktree context line is judged by that path region too, so the older spaced-capture rule no longer records a line's text — unless the capture itself is spaced and the line's grammar ends no earlier, which is the ambiguity that rule exists for. The residual section names the cases where the grammar cannot settle.

`git grep --heading` output is **not observed**: file-name attribution is out of scope under contract revision 1, and the follow-up is Gru's to file. A guard test pins the non-observation so a later change cannot assume heading support.

This continues the stranded #528 lane. Its change came in as a single squashed commit with no history, because two of its old commit messages spelled excluded-path examples that a blind reviewer reading the log would have been recorded as having read.

## R1-R5

| Finding | Resolution |
|---|---|
| **R1** private text in the ledger | Each line is judged by its **path region**: a match line's number ends it; so does the first head that reaches a dotted file name; a name that goes on with dash-separated numbers to a later extension is one name. A path no delimiter settled (extensionless) offers only whitespace-free heads. The later-head gate and the longest-candidate rule that let a context line's text ride `path` and `detail` are gone from the region judgement, and a spaced capture that runs across the line's own line number is now judged by the region. The leak and the false positive of the review are both tests, as is the case where the older capture must still win (a whitespace-free name whose dotted part is followed by a written-out part). |
| **R2** revisions ending in `-<digits>` | Numbers and dots inside a revision end nothing: `pr-528`, `v1-2-0`, `release-2026-10-29`, `feat/node.js-18-lts` and `v2.beta-5-gabc1234` are in the any-spelling matrix, match and context forms, plus a joint case where a dated revision and a quoted path meet. |
| **R3** `..` behind a revision | A parent-relative path behind a whitespace-free revision is judged by its shape, as the older match form judges one. Absolute, drive-letter and URL-shaped heads stay judged by the globs only. Both sides are tests, including the subdirectory regression. |
| **R4** commit messages are reviewer-visible | This branch's commit messages, the PR title and this body spell no such example. The `gc-520-msg-check` scope applies the scanner's own rule to the branch's messages and to the PR text kept in the worktree's knowledge root and requires 0 hits. |
| **R5** `--heading` | Out of scope under contract revision 1; file-name attribution is not observed (see above). `-l` and `-c` are out of scope too. |

## Verification

Every scope ran through the authenticated verify scheduler. The property-real fixture was materialized in this worktree before the full scope (the provisioning tool refuses a second materialization by design).

| Scope | Head | Run id | Outcome |
|---|---|---|---|
| `gc-520-focused` | 99432789 | `a2a40ec1-5cad-4bd2-91e1-3ebcd4d92da6` | exit 0 |
| `gc-520-static` | 99432789 | `90f169f7-356e-4a1b-b2c3-d48517feb81e` | exit 0 |
| `gc-520-msg-check` | 99432789 | `466d93f4-4a24-422b-8939-7cdef480b1f8` | exit 0 |
| `gc-520-red` | 99432789 | `b9413df6-f899-48f6-980f-2652258efd66` | exit 1 by design; classifier RED PROVEN for A1-A6 at the contract's base |
| `gc-520-red-4a269d13` | 99432789 | `216eba76-766e-454b-8c31-a88af9c00cc0` | exit 1 by design; classifier RED PROVEN for the six cases at the earlier lane's head |
| `full` | 99432789 | `309b1ec5-b6f5-44e5-925c-42e898340a1c`, `3932691b-f657-4a7c-a08b-730356b63551` | **not green**: host-load timeouts in untouched tests (see below) |

`full` at this head passed its fast phase outright on both attempts (212 files passed, 4 skipped) and failed only in the heavy phase, on one untouched test that exceeds its 120 s ceiling under this host's load average of 12-24 — a different test from the two 30 s fast-phase timeouts seen on the previous head, and unrelated to any file this change touches. The newest attempt's run id and outcome are recorded in this PR's final comment; `gc-520-focused`, `gc-520-static`, `gc-520-msg-check` and both red scopes are green at the delivered head.

## Red proof

`gc-520-red` extracts the base the contract names, overlays the final test files and runs the contract's fail-before cases only; `gc-520-red-4a269d13` does the same against the earlier lane's head with the cases contract revision 1 names. Both classify their Vitest report: every named case must be present, failed and failed **by assertion** — a collection or import failure is not red evidence — and an unrelated failure fails the classification. Both exit non-zero by design; each classifier printed `RED PROVEN: every named case failed by assertion`.

## Review

The change went through three independent tracked review rounds (two complete rounds at earlier heads, and a complete pass at the delivered head by the edge-case and intent-alignment lenses) with every finding triaged: the regression the third round found is fixed with a test, the documentation paragraph it contradicted is restated, and the shapes that remain are named as residuals below.

A **blind** lens cannot be commissioned for this change: its package must carry the base-to-head diff verbatim, and three lines this change REMOVES from the base are grep-shaped once a diff marker precedes them, so the package is refused (`blind_input_refused`, `unbound-package`) and any redaction breaks the hunk-to-blob binding. That capability gap is recorded here, not hidden; the diff's removed-line hits are also why the per-file self-scan covers the head files in every line form but cannot cover the base-side removed lines.

## Residuals (named, not hidden)

- A bare listing of a path with no extension but with dash-separated numbers is read as a hit of the date-like fragment; a context line whose entire text is one dotted token is read as such a listing instead, so it is not observed.
- A worktree context line of an **extensionless** path still records up to a dotted token or a no-space colon number in its text, because a head that reaches a file name — or, for an extensionless path, the last delimiter — ends the region by design.
- A revision or context line whose name has a dotted part followed by a *written-out* part rather than numbers is settled at the dotted part, so under a suffix rule the file can be missed, and under a prefix rule a truncated path is recorded (the whole file is still observed).
- A git revision spelled only with digits (a numeric tag or branch) is not read: the head is taken for an earlier line number, and there is no heading form left that needs that reading.
- A spaced path with no extension is read in match form only.
- `git grep --heading`, `-l` and `-c` are not observed: out of scope under contract revision 1.

No stored ledger event, rule, glob or schema changes; the change can only add hits to observations recorded after it.
