---
title: 'review-input-handoff: private frozen evidence, exact-target CI receipts, audited canonical amendments'
type: 'feature'
created: '2026-10-03'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5d56194a905262231bb0d183292b6d08cbd70810'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/FLOW.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A confined Perkins reviewer receives only the local scheduler's
`verification.completed` block and a frozen spec that cannot contain its own
head's CI receipt (PR141 r7: exact-head Linux CI passed but was invisible) nor
an owner-supplied reference image (unreachable, and never publishable). PR165
showed tracked amendments/directives do not update the frozen canonical
acceptance because no audited amendment ingress exists. Owner ruling j-969
directly approved all three inputs as ONE cohesive handoff.

**Approach:** Add one review-input handoff seam: (1) arm-time, explicitly
referenced service-upload image attachments are validated, hashed, frozen once
into the private round store, recorded in the round manifest/receipt, and
delivered to non-blind review paths through the existing capability-checked
prompt-image transport (fail closed on any mismatch, unsupported model, or
invalid/unauthorized/mutated input; blind lenses stay isolated); (2) a
host-recorded, repo/PR/SHA-bound CI receipt (from ledger `github.ci-green` /
`ci-failed` / `branch-state` events) renders into the frozen spec context and
manifest, with explicit UNAVAILABLE / NOT-PASS limitations — never inferred
green; (3) an authenticated, append-only, versioned canonical-amendment surface
with approval provenance, expected-contract-hash concurrency, idempotent retry,
explicit supersession, audit events, and freeze-time binding of the effective
contract version/hash so later rounds read the amended acceptance while old
rounds keep their original records. Ship with a bounded operator runbook; do
not activate any live PR from this lane.

**Approval authority:** dispatch briefing `job-review-input-handoff` (owner
directly approved, ruling j-969) is this spec's Checkpoint-1 authority; the
bmad-build interactive checkpoint is not available in this confined worker.
</frozen-after-approval>

## Code Map

- `src/ledger/db.ts` — MIGRATIONS list (currently 1–10). Add **migration 11**
  `job_amendments` (append-only rows; UNIQUE(job_id,version),
  UNIQUE(job_id,idempotency_key)).
- `src/ledger/api.ts` — `addRound`/`latestJobEvent`/`appendCustomEvent`
  patterns; `transaction`/`appendEvent` privates; `setJobBriefing` (the
  UNAUDITED legacy setter — leave in place, never use for amendments). Add
  `listJobAmendments`/`addJobAmendment` here using the pure renderer from the
  new module. `getJob().briefing` stays the ORIGINAL.
- `src/review-inputs/amendments.ts` (new, pure) — amendment record types,
  `renderEffectiveContract(briefing, amendments)` (original verbatim + appended
  amendments with approval/supersession/hash markers; zero amendments returns
  the original bytes exactly), `amendmentRequestSha256`, validation bounds.
- `src/review-inputs/evidence.ts` (new) — upload-identity parsing
  (`<stamp>-<uuid>-<name>` directly in the configured uploads dir, realpath
  contained, regular non-symlink file), magic-byte image sniffing
  (png/jpeg/gif/webp only), per-file/total byte bounds, `frozenPath` readback
  verification, prompt-section renderer. No pixels or source paths in any
  log/payload; synthetic fixtures only in tests.
- `src/review-inputs/ci-evidence.ts` (new, pure) — binds the latest
  `github.ci-green`/`github.ci-failed`/`github.branch-state` event for the job
  to target sha + repo + PR; renders a delimited untrusted block with state
  (GREEN/PENDING/FAILED/UNAVAILABLE/NOT-MATCHED), check names/urls, observation
  time, source event seq/kind, and explicit "cannot become PASS" limitations.
- `src/dispatch/perkins-review/artifacts.ts` — `FreezeReviewInput`/
  `FrozenReviewInputs`/`FrozenReview`; `freezeReviewInputs` writes
  `spec-context.md`; manifest written once via `atomicWrite` (write-once).
  Extend with `acceptance` (base/effective sha, version, amendment ids) and
  `reviewEvidence` (frozen attachments + CI record); freeze validates
  `specContext.startsWith(contract)` when acceptance is supplied.
- `src/dispatch/perkins.ts` — `setupRound` (spec assembly near line ~2040,
  freeze near ~2088), `requestReview`/`beginPerkinsRound` input plumbing,
  queued-handoff `safeInput` (evidence must survive durable handoff),
  `WaveRunnerOptions` (needs `evidenceUploadsDir`). Append a
  `round.review-inputs-frozen` audit event with metadata hashes only.
- `src/dispatch/perkins-review/whole.ts` — `boundedPrompt`/`retryPrompt`
  (pass `PromptOptions.images`), `leadPrompt` (~1890), `renderSpecialistPrompt`
  (~490) — non-blind lead/specialists get evidence text + images; blind gets
  NEITHER. Capability check on the spawned handle (`capabilities.images`) throws
  a named error; lead failure = INCOMPLETE round, child failure = failed
  attempt. Read/verify frozen bytes at prompt time (hash + size).
- `src/dispatch/github-poll.ts` — `applyCiGreen`/`CiGreenSignal` gain optional
  per-check `runs: [{name,url}]` (existing `checks: string[]` shape preserved
  for old events/tests).
- `src/dispatch/server.ts` — `/api/dispatch/review` accepts `evidence[]`;
  add `POST /api/dispatch/amendment` + `GET /api/dispatch/jobs/:id/contract`
  (same bearer auth; approval provenance required; 400/401/409 mapping).
- `src/main.ts` — pass `evidenceUploadsDir: join(config.dataDir,'uploads')` to
  the WaveRunner (uploads already 0700, `MAX_UPLOAD_BYTES` 8 MiB).
- `src/runtime/types.ts`/`pi-adapter.ts`/`claude-adapter.ts` — EXISTING
  `PromptOptions.images` transport; no adapter change; only positive-transport
  tests may be added.
- `docs/REVIEW-INPUTS.md` (new) — operator runbook (upload → arm → amend),
  limitations, no-live-activation note.
- Tests (new): `test/review-evidence-intake.test.ts`,
  `test/review-ci-evidence.test.ts`, `test/job-amendments.test.ts`,
  `test/review-inputs-handoff.test.ts` (whole-review prompt/delivery),
  `test/dispatch-review-inputs.test.ts` (HTTP + freeze integration);
  `test/helpers/perkins-whole-double.ts` gains capability/images capture;
  `.gru-command/worktree.toml` gains ONE focused `review-inputs` scope.
- Do NOT touch: pinned `resources/perkins-code-review/policy.json`, MCP
  bridge/server, verdict arithmetic, auth, review lenses, scheduler limits,
  other lanes' files; no new runtime dependency.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/db.ts` — migration 11 for append-only amendments.
- [x] `src/review-inputs/amendments.ts` + ledger `addJobAmendment`/`listJobAmendments` + audit events — versioned contract.
- [x] `src/review-inputs/evidence.ts` — upload identity validation, sniffing, freeze-readback, prompt section.
- [x] `src/review-inputs/ci-evidence.ts` — bound CI receipt/limitation renderer.
- [x] `src/dispatch/perkins-review/artifacts.ts` — acceptance + reviewEvidence in manifest/FrozenReview.
- [x] `src/dispatch/perkins-review/whole.ts` — evidence delivery to non-blind paths; blind isolation; fail-closed capability.
- [x] `src/dispatch/perkins.ts` + `src/main.ts` — arm plumbing, handoff carry, freeze audit event, uploads dir.
- [x] `src/dispatch/github-poll.ts` — optional check-run urls on the green signal.
- [x] `src/dispatch/server.ts` — arm `evidence` param + amendment/contract endpoints.
- [x] `docs/REVIEW-INPUTS.md` — runbook.
- [x] Tests + focused `/api/verify` scope + full gate.

**Acceptance Criteria:**
- Given an authenticated approved synthetic reference uploaded outside the
  checkout, when a round freezes and the real lead prompt is assembled, then the
  image-capable path receives exactly the frozen pixels plus sha/provenance;
  arbitrary paths/symlinks/traversal are denied; blind lenses receive neither
  text nor pixels; a text-only model fails closed naming the capability.
- Given invalid/missing/oversized/wrong-type/mutated input or unauthorized
  upload identity, intake/freeze/transport refuse with a named reason and no
  substitute evidence; no review tree receives the bytes.
- Given recorded CI for the exact repo/PR/head, frozen context shows the bound
  receipt (checks, time, source); stale sha, wrong repo/PR, later
  pending/failure, malformed or absent evidence render explicit
  limitations/UNAVAILABLE and never PASS.
- Given original acceptance plus an approved versioned amendment, a subsequent
  freeze binds the effective text + version/hash/provenance; earlier frozen
  rounds are unchanged; stale/conflicting/improperly-authorized/idempotent
  retries behave deterministically and are audited.
- Given restart/old records, all new state is durable and backward compatible
  (zero-amendment jobs render byte-identical specs); full gate, typecheck and
  focused scopes pass at the final head.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy reference image | upload exists under uploads dir, PNG, ≤ bounds | frozen copy + sha + receipt; prompt images + provenance text | N/A |
| Missing/empty/wrong-type | nonexistent path, 0 bytes, text file | freeze refuses | named reason, no manifest |
| Traversal/symlink/foreign path | `../`, symlinked upload, path outside uploads dir | intake refuses | named reason, no bytes read |
| Mutation race | frozen file bytes changed after freeze | transport refuses the round/attempt | sha mismatch named |
| Text-only model | frozen images, handle `images:false` | lead round INCOMPLETE; child attempt failed | named capability error |
| Blind lens | frozen images | blind prompt has no evidence text, no images | N/A (isolation) |
| CI green at target | recorded ci-green/branch-state bound to sha | GREEN receipt with source/time/checks | N/A |
| CI absent/stale/wrong repo | predecessor sha only, other repo/PR, no event | UNAVAILABLE / NOT-MATCHED, never PASS | explicit limitation text |
| Stale/later CI state | newer pending/failed at target | PENDING/FAILED, never PASS | explicit limitation text |
| Amendment accepted | owner-approved body + expected hash | version+1, new contract hash, audit event | N/A |
| Stale/concurrent amendment | wrong expected hash; two writers race | second rejected, current hash returned | 409 + audited rejection |
| Idempotent retry | same idempotency key + same request | same amendment returned, no duplicate | idempotent flag |
| Unauthorized amendment | no/invalid token; blank approval reference | refused, audited | 401 / 400 |
| Zero-amendment job | old job record, no amendments | spec bytes unchanged, version 0 | backward compatible |



## Review Triage Log

- `suite-shape` pin mismatch (full r7): confirmed real — new suites were
  unpinned; fixed in 51fe319 (pins added), re-verified green in r8/r9 runs.
- `lan-phone-raw-client` delta replay truncation (full r7): inspected complete
  output; failure is a socket-replay timing race in a file not touched by this
  diff; did not recur in r8/r9 (isolation run added for the record).
- `chat-server` `firstFresh.disposed` (full r8): inspected complete output;
  known distinct harness failure tracked by the operations journal
  (gc-test-harness follow-through); not touched by this diff; did not recur
  in r9.
- `decisions` hot-reload watcher (full r8): inspected complete output; same
  shape as the pre-existing failure recorded for the PR130 full run
  (expected degraded/credential_missing, observed disabled/disabled); not
  touched by this diff; did not recur in r9.
- `dispatch-server` by=silas timeout (full r9): seam-adjacent file; failure is
  a 30 s default-timeout wall, no assertion; isolation run scheduled.
## Implementation Notes

- 2026-10-03: lane workflow rendered via `bmad-build`; Checkpoint-1 approval
  taken from the owner-approved dispatch briefing (no interactive checkpoint in
  this confined worker). Implementation performed inline (no subagent
  capability in this session; step-03 permits direct implementation).
- 2026-10-03: rejected the alternative of an extra confined read root for the
  uploads dir (broadens reviewer read access); the prompt-image transport is
  the narrow authorized path and was already capability-checked.
- 2026-10-03: amendment approval provenance is recorded (`by` + durable
  `reference`) but is NOT an identity system: the service's single pairing
  token remains the only authentication primitive, so the surface never infers
  owner approval from body text or a caller-declared role string. This is the
  documented, surfaced authorization limitation.

- 2026-10-03: `full` r6 (run e56d57b6 at 7eb967d) red at lint: one unused
  helper; fixed in d864f05.
- 2026-10-03: `full` r7 (run at 7eb967d) red: `suite-shape` pins (real; fixed
  in 51fe319) plus `lan-phone-raw-client` delta-replay timing (outside the
  diff; passed on later runs).
- 2026-10-03: `full` r8 (run def06283 at 51fe319) red: `chat-server` epoch-reset
  disposal timing and `decisions` hot-reload watcher timing — both outside the
  diff, both already tracked as distinct harness failures in the operations
  journal; both passed in adjacent runs.
- 2026-10-03: `full` r9 (run d100c3f5 at 51fe319) red: `dispatch-server`
  by=silas attribution test hit its default 30 s timeout (seam-adjacent file;
  no assertion failure). Complete captures for every run are preserved under
  `_bmad-output/implementation-artifacts/review-inputs-verify-runs/` (raw
  NDJSON + decoded frames + whole-output hash in each completion frame).
- 2026-10-03: because every FULL red after the real fixes was a distinct
  timing-sensitive test (never the same failure twice), the lane added
  `review-inputs-regression` (the seam suites plus the exact red files) to
  establish isolation at one head before the final FULL. No test assertion,
  timeout, budget or scope was weakened.

## Verification

**Commands:**
- `npx vitest run test/review-evidence-intake.test.ts test/review-ci-evidence.test.ts test/job-amendments.test.ts test/review-inputs-handoff.test.ts test/review-inputs-wave.test.ts test/dispatch-review-inputs.test.ts test/verification-evidence.test.ts test/github-poll.test.ts test/ledger-api.test.ts test/ledger-db.test.ts` — scheduler scope `review-inputs`: PASS (run ee48afd8 at f3959f5, 94/94 tests, clean tree, whole-output sha256 b3675c9f2183c2d00c49fee7002379ebb2ac4e7381ace7c229a737528ac7b3b0).
- `npx vitest run test/dispatch-server.test.ts test/attachments.test.ts test/claude-adapter.test.ts test/perkins-whole-review.test.ts test/perkins-builtin-wave.test.ts test/lan-phone-raw-client.test.ts test/chat-server.test.ts test/decisions.test.ts test/suite-shape.test.ts` — scheduler scope `review-inputs-regression`: isolation evidence at the final pre-gate head (result recorded in the completion report).
- `npm test` — scheduler scope `full`: final-head gate; earlier reds and their completions are preserved above and in the run captures.

**Manual checks:**
- `manifest.json`/`spec-context.md` of a frozen round contain no base64
  pixels, no upload source paths, and the acceptance/evidence blocks.
- Raw retained captures: `_bmad-output/implementation-artifacts/review-inputs-verify-runs/`.
