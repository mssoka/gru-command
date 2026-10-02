# PR69 — fresh-main fix-loop delivery

The current re-brief explicitly supersedes the earlier merge-only/no-rebase
integration procedure. This attempt rebased the existing PR69 branch onto
fresh main; PR identity is unchanged, and merging remains owner-held.

- Starting remote head: `5389a28f6b0d343f1dd7b70a80b57787be88c9f0`.
- Rebase base: `c54bfbf89727bacfd27a27db65a9fab681c19c3e` (includes #140, #131, and #133).
- Code/test candidate: `5381d92d58a3faa576cbbaab79f7b48e0b6d1bb6`.
- Collision check: all eight lane rounds were terminal (`verdict-posted`
  or `aborted`); no live or pending review round was armed by this worker.
- Rebase resolutions preserved both LEDGER documentation sections, the
  residency imports plus the origin-ref classifier, and main's awaited
  async bootstrap. Shared suite pins were recomputed from registered tests;
  the merged owner-actions suite is pinned at 8.

### Fix and acceptance evidence

- Release containment accepts other local branches/tags or ONLY the live-
  verified, freshly fetched origin default. Offline/unverified defaults and
  other stale tracking refs cannot witness deletion.
- Swept-row healing and missing-tree reconciliation refresh BEFORE disposal.
- Removed the `git branch -d` shortcut: Git can delete on a stale configured
  lane upstream even when local HEAD does not contain the tip. Explicit
  bases obey the same durable-witness rule and cannot witness themselves.
- Seven regression fixtures cover offline force-push, deleted default,
  swept-row retry, missing-tree reconciliation, renamed default, stale lane
  upstream, and explicit stale remote base. All seven failed with
  `deleted` rather than `retained` against pre-fix manager
  `dd65aa7f4201467c66547b09b0d4cd6e2843abec`; all seven pass after the fix, with the original tip reachable
  through the retained lane branch. No timeouts or assertions were relaxed.
- Two whole-round freeze tests now use the production WorktreeManager,
  rather than a copied resolver: fetched target, registered detached SHA,
  and manifest agree; a fetch failure aborts before a round, review tree,
  or minion spawn. Both pass (canonical fixture paths on macOS).
- Lint, typecheck, build, the seven release regressions, both manager-backed
  freeze cases, and suite-shape pass. The initial broader focused run passed
  all worktree/freeze/manifest assertions but reported Vitest worker RPC
  errors and an upstream missing owner-actions pin (now corrected).
- Full `npm test` submitted through the shared verification scheduler:
  run `36fe2e10-a89f-43b0-91f3-f54de0a7661e`. It was queued behind the
  existing verification lease when this note was written. Final outcome
  belongs to that ledger receipt and the exact-head GitHub CI run, not to
  the earlier focused output. No runner timeout/dependency patch was made.

### Delivery boundaries

Push is authorized by the re-brief and must use an explicit lease against
`5389a28f6b0d343f1dd7b70a80b57787be88c9f0`, rechecking the no-live-round guard first. A changed head requires
fresh Perkins review; no approval is claimed here. Existing non-blocker
warnings (including synchronous network Git) are not silently declared fixed.
No edits to other lanes, no review arming, no merge, deploy, or service restart.
