# #74 quick-review finding fix — scoped disposition

**Scope:** one authorized quick-review finding from the owner-requested
independent review at head `34aa332869144b56004998190e334de560600858`
(`edge-case-hunter` 0 + its `verification-gap` regression gap; canonical
JSON beside the archived review record). No Perkins round verdict is
claimed or implied; the two-lens review remains the accepted evidence for
this defect and its disposition.

## Finding

`src/dispatch/perkins-review/hybrid.ts` `changedSourcesForAddedPath`
admitted only M/D prior blobs (`newPath === null || newPath === oldPath`)
as candidate reuse sources for an A-path proof. A Git rename entry
(`R### old new`) carrying a byte-identical or similar prior blob was never
inspected, so a separately added caller quoting the renamed file's
unchanged prior line (plus a novel line, defeating blob-OID equality)
passed attribution as newly authored — the same unchanged-old-line
masquerade class the r4 M+A repair rejects, reachable one
rename-detection away.

## Repair

The candidate filter now admits every frozen prior blob that is not the
proof target itself: `oldPath !== null && oldPath !== path && newPath !==
path` (M, D and R old sides alike). A rename's old side is a frozen prior
blob exactly like an M/D old side. No thresholds, guards or scope changed:
the ≥2-shared-nonempty-lines majority rule, blob-OID equality, binary and
non-regular skip, 4× size ratio, 256-path and 8 MiB inspected-byte bounds,
and ambiguous-multi-source fail-closed all apply unchanged to the newly
admitted R entries. Callers proved through their own rename entry keep
their existing hunk-bound route (`changedSourcesForAddedPath` is only
entered for a true A entry).

## Tests

`renamedSourceSibling` fixture: prior `src/caller.ts`
(`const unchanged = true;\nconst selected = nativeRef;\n`), then one commit
performing `git mv src/caller.ts src/renamed.ts` plus added
`src/sibling.ts` = both prior lines verbatim plus the novel
`const novel = genuineChange;` — two shared nonempty lines, majority of
the smaller side, within the 4× size ratio, distinct blob OID; asserted as
`R### src/caller.ts src/renamed.ts` + `A src/sibling.ts` against real Git.

- Red (pre-fix): the masquerade audit
  (`fix_location src/sibling.ts added`, evidence `const selected =
  nativeRef;`, a real unchanged prior line) was **accepted** —
  `promise resolved instead of rejecting`, terminal report consolidated.
- Green (post-fix): rejected with `fix_location src/sibling.ts evidence is
  an unchanged line in changed source src/caller.ts`; preflight
  `"ok":false`; no `consolidated.json`. The novel-line variant on the same
  R fixture stays accepted. Existing M+A negative, edited-copy positive,
  ambiguity, binary/oversized guards, rename-only/edited-rename/directory
  caller proofs and genuinely-new-caller all re-verified green in bounded
  slices. Suite-shape pin 146 → 148.

## Verification trail (nonzero exits retained truthfully)

- Red `npx vitest run test/perkins-builtin-review.test.ts -t 'renamed
  source in a separate added caller|novel line in a caller beside a renamed
  source'` — exit 1: negative failed because the run **resolved** with the
  masquerade audit accepted; positive passed.
- Green same selector — exit 0 (2 passed). `-t 'unchanged caller line
  copied from a rewritten source|novel line in an edited copy|genuinely new
  caller with tool-derived'` — exit 0 (3). `-t 'quoted unchanged line in a
  Git-recognized rename-only caller|added-line proof in a Git-recognized
  edited caller rename|removed-line proof in a Git-recognized edited caller
  rename'` — exit 0 (3). `-t 'two matching changed sources'` — exit 0 (1).
  `-t 'unrelated binary changed source|unrelated oversized changed
  source'` — exit 0 (2). `-t 'unrelated descendant hunk after an unchanged
  caller is renamed|edited rename also replaces its old path with a
  directory|only the deleted regular caller'` — exit 0 (3).
- One combined 8-case run passed every assertion but reported the known
  host-load `vitest-worker: Timeout calling "onTaskUpdate"` RPC error
  (exit 1, no test failure); the affected cases were re-verified green in
  the bounded slices above. Known-local limitation, unchanged in kind from
  the Part-A record.
- `npx vitest run test/suite-shape.test.ts test/perkins-lead-schema-compat.test.ts
  test/verify-perkins-resource.test.ts --maxWorkers=1` — exit 0 (10
  passed, 1 intentional live skip). `npm run lint`, `npm run typecheck`,
  `npm run build` (includes the resource verifier), standalone
  `node tools/verify-perkins-resource.mjs .` — all exit 0. Policy
  (`325f7517…`) and MCP-server pins unchanged; no repin required. The slow
  entire local full-file/full-suite run was deliberately not repeated.
