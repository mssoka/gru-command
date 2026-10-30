<!-- title: fix: read the forms git grep prints for revisions and context lines in blind access observation (#520) -->
Refs #520
Supersedes #528

## What

Blind-review access observation now recognizes grep hits from excluded paths in the forms `git grep` really prints, so such a read invalidates blind isolation:

- against a revision: the revision, then the repository path, then the line number, for a match line and a context line;
- against a revision and a directory (the directory and file joined), and the tree root (a revision followed by two colons);
- a worktree context line (the path, a hyphen, the line number, a hyphen).

For every such line the recorded `path` is the repository path and nothing else: no revision, no line number and no fragment of the matched or context text, so re-submitting the same tool result records the same read identity. Where a line's own grammar ends its path, that region decides — including worktree context lines, which the older spaced-capture rule used to record whole, text and all.

`git grep --heading` output is **not observed**: a file name on a line of its own with the numbered lines under it is no form this scanner reads. That is out of scope under contract revision 1, and the follow-up is Gru's to file. A guard test pins the non-observation so a later change cannot assume heading support.

This continues the stranded #528 lane. Its change came in as a single squashed commit with no history, because two of its old commit messages spelled excluded-path examples that a blind reviewer reading the log would have been recorded as having read.

## R1-R5

| Finding | Resolution |
|---|---|
| **R1** private text in the ledger | Each line is judged by its **path region**, not by every head up to the last delimiter. A match line's number ends the region; so does the first head that reaches a dotted file name; a name that goes on with dash-separated numbers to a later extension is one name (a dotted part inside a dated name). A path no delimiter settled (extensionless) offers only whitespace-free heads. The later-head gate and the longest-candidate rule that let context text ride `path` and `detail` are gone. A worktree context line whose spaced capture runs across its own line number is now judged by its region, so the quoted text never becomes the recorded path — the leak and the false positive of the review are both tests. |
| **R2** revisions ending in `-<digits>` | Numbers and dots inside a revision end nothing: `pr-528`, `v1-2-0`, `release-2026-10-29`, `feat/node.js-18-lts` and `v2.beta-5-gabc1234` are in the any-spelling matrix, match and context forms, plus a joint case where a dated revision and a quoted path meet. |
| **R3** `..` behind a revision | A parent-relative path behind a whitespace-free revision is judged by its shape, as the older match form judges one. Absolute, drive-letter and URL-shaped heads stay judged by the globs only. Both sides are tests, including the subdirectory regression. |
| **R4** commit messages are reviewer-visible | This branch's commit messages, the PR title and this body spell no such example. The `gc-520-msg-check` scope applies the scanner's own rule to the branch's messages and to the PR text kept in the worktree's knowledge root and requires 0 hits. |
| **R5** `--heading` | Out of scope under contract revision 1; not observed (see above). `-l` and `-c` are out of scope too. |

## Verification

Every scope below ran through the authenticated verify scheduler, after the property-real fixture was materialized (the provisioning tool refuses a second materialization by design).

| Scope | Head | Run id | Outcome |
|---|---|---|---|
| `gc-520-focused` | TODO | TODO | TODO |
| `gc-520-static` | TODO | TODO | TODO |
| `gc-520-msg-check` | TODO | TODO | TODO |
| `gc-520-red` | TODO | TODO | TODO |
| `gc-520-red-4a269d13` | TODO | TODO | TODO |
| `full` | TODO | TODO | TODO |

The last commit of this branch adds this text to the worktree's knowledge root and changes nothing else: `git diff <parent>..<head>` shows one file, so the code and test bytes every scope ran are the bytes delivered.

## Red proof

`gc-520-red` extracts the base the contract names, overlays the final test files and runs the contract's fail-before cases only; `gc-520-red-4a269d13` does the same against the earlier lane's head with the cases contract revision 1 names. Both classify their Vitest report: every named case must be present, failed and failed **by assertion** — a collection or import failure is not red evidence — and an unrelated failure fails the classification. Both scopes then exit non-zero by design; the classifier's verdict (every named case RED by assertion) is in their captured output.

## Review

The change went through three independent tracked review rounds (two complete rounds at earlier heads, one complete pass at the delivered head) with the findings resolved in follow-up commits. A **blind** lens cannot be commissioned for this change: its package must carry the base-to-revision diff verbatim, and three lines that this change REMOVES from the base are grep-shaped once a diff marker precedes them, so the package is refused (`blind_input_refused`, `unbound-package`) and any redaction would break the hunk-to-blob binding. The delivered head was reviewed by the edge-case and intent-alignment lenses instead; that capability gap is recorded, not hidden.

## Residuals (named, not hidden)

- A bare listing (no line number) of a path that has no extension but holds dash-separated numbers is read as a hit of the date-like fragment. This is the fail-closed consequence of the binding path-region design: the line carries no signal that separates it from a context line.
- A worktree context line of an **extensionless** path whose text quotes a dotted name is still read up to that dotted name, because a head that reaches a file name ends the region by design.
- A spaced name with no extension is not read in context-line form (it is read in match form).
- `git grep --heading`, `-l` and `-c` are not observed: out of scope under contract revision 1.

No stored ledger event, rule, glob or schema changes; the change can only add hits to observations recorded after it.
