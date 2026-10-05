# Final independent review round — findings and dispositions

Three fresh service-created review jobs ran the installed `bmad-review`
lenses against packet v2 (product head `5c0d1d3`, packet commit
`821ead3f`, manifest `76c2eb80…`). Each declared its bounded inputs and
hash-verified them against the manifest before and after analysis; the
full findings and receipts are in `../review-round/`. Every finding was
triaged; the disposition column names the repair, regression or packet fix
delivered in the product head `9ba8637` / this packet rebuild.

| # | review | location | disposition |
|---|---|---|---|
| A1 | adversarial | `bmad-onboarding.ts` managedBlock | **Fixed** — unpaired managed markers now throw `BmadDeterministicSetupError` (skip-only, names the paired markers); regression "unpaired managed-block markers …". |
| A2 | adversarial | post-merge evidence head binding | **Fixed (packet)** — manifest `head_chain` + populated product file blobs make the run-head/product-head relationship machine-checkable. |
| A3 | adversarial | empty `product_files_at_head` | **Fixed (packet)** — populated with `{path, blob}` for every diff-touched file at the frozen head. |
| A4 | adversarial | historical vs post-merge run ambiguity | **Fixed (packet)** — verification stages are separated (`pre-merge/`, `post-merge/`, `repaired/`) and the head chain labels each supersession. |
| A5 | adversarial | `validatedSkillPath` misattribution | **Fixed** — repository / skills-root / recorded-binding misses each get their own message; ENOENT/ENOTDIR split preserved; regressions "missing skills root and ENOTDIR root …". |
| A6 | adversarial | preflight message leaks staging path | **Fixed** — the disposable-staging path is stripped from the message; assertion added to the existing preflight regression. |
| A7 | adversarial | ancestor symlink refusals lack the hint | **Fixed** — the installer hint is threaded through the existing-state ancestor checks (`_bmad`, `.agents/.claude` skills roots); regression "ancestor symlink refusals carry the official-installer repair hint …". |
| A8 | adversarial | manifest read-failure arm uncovered | **Regression added** — "a denied manifest read stays transient and recovers on the SAME collected answers". |
| A9 | adversarial | validatedSkillPath ENOTDIR / rethrow arms uncovered | **Regressions added** — covered by the ENOTDIR and EACCES legs of "missing skills root and ENOTDIR root …". |
| A10 | adversarial | fresh-record hashing classified deterministic | **Fixed** — fresh installer output (post-install validations and the fresh record hash) is transient; reuse-path validation of unchanged bytes stays deterministic; regression "fresh-installer output failing post-install validation stays transient …". |
| A11 | adversarial | e2e band expansion clicked unconditionally | **Fixed** — the reflow helper asserts `aria-expanded=false`, expands, then asserts `true`. |
| A12 | adversarial | README wording vs classes without hints | **Fixed** — README now states install-repair classes name the installer path and other deterministic classes carry deliberate repair guidance. |
| A13 | adversarial | mock hold has no direct coverage | **Regression added** — `mock-server-http.test.ts` "parks the scripted turn until release, and reset settles a parked turn without ghost frames". |
| E1 | edge-case | fresh-install output guards (claim) | **Fixed** — same as A10. |
| E2 | edge-case | managedBlock malformed markers | **Fixed** — same as A1. |
| E3 | edge-case | git-toplevel realpath errno | **Fixed** — ENOENT/ENOTDIR stay deterministic; other errno rethrow transient; regressions in "validateRepo refusals outside the covered pair …". |
| V1 | verification-gap | reuse-path content-validator classifications unpinned | **Regressions added** — "reuse-path content validator classifications are pinned (final review)" (missing bmad-build skill, symlinked entry, owned-payload symlink, recorded skill file). |
| V2 | verification-gap | `verifyNoAmbiguousSkillConfig` unpinned | **Regression added** — raw short-token reuse case asserts the deterministic classification and the installer hint. |
| V3 | verification-gap | control-file refusals unpinned | **Regression added** — "control-file refusals are deterministic skip-only without mutation" (record symlink, malformed record, foreign record, malformed worktree manifest). |
| V4 | verification-gap | validateRepo terminal refusals unpinned | **Regression added** — deleted-repo race + fake-git ghost/denied top-level cases; the symlink-escapes and not-root arms were already covered by the existing refusal matrix. |
| V5 | verification-gap | neutral hint-less fallback unobserved | **Regression added** — noninteractive wizard leg asserting the exact fallback wording for a hint-less deterministic class. |
| V6 | verification-gap | empty `product_files_at_head` | **Fixed (packet)** — same as A3. |

Repairs verified by the repaired-head scopes at `9ba8637`: `wizard-bmad-retry`
(focused, 67/67), `typecheck`, `full` (backend + web + hygiene) and
`wizard-bmad-browser-consumer` (web unit + Playwright 51/51) — receipts in
`../verification/repaired/`. No assertion, oracle, tolerance, timeout or
deadline was weakened.
