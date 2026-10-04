---
title: 'review-input-handoff: private frozen evidence, exact-target CI receipts, audited canonical amendments'
type: 'feature'
created: '2026-10-03'
status: 'done'
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

- `src/ledger/db.ts` — MIGRATIONS list (currently 1–13 after the main
  integration). Add **migration 14**
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
  `.gru-command/worktree.toml` gains the durable `review-inputs` focused
  scope plus retained lane diagnostics (`review-inputs-regression`,
  `installer-isolation`), all routed through the workload-aware configs.
- Do NOT touch: pinned `resources/perkins-code-review/policy.json`, MCP
  bridge/server, verdict arithmetic, auth, review lenses, scheduler limits,
  other lanes' files; no new runtime dependency.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/db.ts` — migration 14 for append-only amendments.
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
  (zero-amendment jobs render the original briefing bytes as the contract
  slice; every new frozen round adds the explicit review-input/CI blocks by
  design); full gate, typecheck and
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
  a 30 s default-timeout wall, no assertion; PASSED in the r10 isolation run
  (444/445; the sole red was `decisions.test.ts`).
- `decisions` hot-reload (r8 + r10): reproducible in isolation without this
  lane's suites; pre-existing fs-watch timing, outside the diff and outside
  this lane's ownership; preserved for the review/owner disposition.
- `install-one-line` owned/foreign-service timeout (full `15bfc4a9` at
  `13b8734`): classified CONTENTION — isolation scope `installer-isolation`
  PASS at `c08b7e1` (18219 ms), failing test file and `install.sh`
  byte-identical to the earlier green head. No repair needed.
- `perkins-builtin-wave` T4 timeout (full `15bfc4a9`): test file byte-identical
  to the green `cea7bbf` head (T4 passed there at 21884 ms); one `t4-oracle`
  attempt refused at the unchanged lock bound (never started). Classification
  folds into the next FULL; retry the oracle first if the FULL reds on T4.
- FULL lint red at `c08b7e1` (run `95f43be3`, 35.6 s): REAL and repaired —
  lane helper `.mjs` scripts under the linted (gitignored) runs directory
  failed `no-undef`; tooling relocated out of the tree. This red was not a
  product regression and never reached the suite.

### 2026-10-04 independent review layers at `7beb58f` (patches at `b247de6`)

Verdicts are the parent's; reviewer-assigned severities were disregarded.

- Migration-number mismatch in the Code Map/Tasks (spec said 11, code ships
  14) — `low`; patched (spec corrected to 14).
- `CI_EVIDENCE_MAX_BYTES` declared and never enforced — `low`; patched
  (constant removed; the real bounds are the rendered-list caps and the
  frozen-spec bound, now documented).
- An oversize CI block was dropped to silence — `medium`; patched
  (`appendCiEvidence` renders an explicit `UNAVAILABLE — CI EVIDENCE OMITTED`
  notice and logs; the structured record stays in the manifest) + test.
- Binding note claimed a repository check the code did not perform — `low`;
  patched to "repository unverified (no PR URL was resolvable)" + test.
- A PR-less observation could bind as the expected PR's receipt — `medium`;
  patched (exact PR match required when the job names a PR) + tests.
- `original:<anchor>` supersession was cosmetic and unvalidated — `low`;
  patched (the anchor must occur in the original briefing; refusal audited)
  + test.
- `NO_BRIEFING_MARKER` was unreachable and would invent text if reached —
  `low`; patched (named refusal).
- The frozen acceptance hash bound untrimmed contract text while the
  freeze trimmed it — `medium`; patched (the frozen spec now keeps the
  contract text byte-exact so the hash and prefix agree) + tests.
- "Byte-identical specs" acceptance and the `reviewEvidence` doc comment
  overclaimed — `low`; patched (acceptance scoped to the contract slice;
  always-present CI record documented).
- The queued-handoff payload persists the absolute upload path against the
  lane's no-paths discipline — `low`; patched (documented as private-ledger
  replay state; public artifacts/logs stay path-free).
- A differing evidence set on a queued/held handoff was discarded without an
  auditable identity — `medium`; patched (`job.review-handoff-conflict` and
  `job.review-handoff-superseded` carry count + opaque request fingerprint;
  first-wins documented) + handoff-replay test.
- Evidence capability was only checked mid-round — `low`; patched (runbook:
  check the review model's image capability before arming).
- Frozen private material/upload quota had no retention story — `low`;
  patched (runbook retention/quota section).
- No read surface for the frozen receipt — `low`; patched (runbook states the
  host-file-only limitation).
- Prompt-block delimiters were spoofable by newline-bearing
  purpose/consent/check fields — `medium`; patched (control characters
  collapsed in both renderers) + tests.
- Rendered amendment bodies can reproduce host marker lines — `low`;
  deferred (authenticated-writer-only; `deferred-work.md`).
- `docs/FLOW.md` and `docs/LEDGER.md` were not updated — `low`; patched.
- Migration 14 lacked the collision-convention comment — `low`; patched.
- Check-name ordering became locale-dependent — `low`; patched
  (deterministic comparator).
- Malformed amendment requests were unaudited and leaked parse errors —
  `medium`; patched (boundary audits, generic 400) + tests.
- "Two writers race -> 409" called unverified — `false` (the ledger
  transaction is synchronous and single-writer; the losing write presents a
  stale hash and is the covered 409; no interleaving exists to test).
- Runbook over/under-documentation (response shape, bounds, grammar,
  retention, receipt) — `low`; patched.
- New suites missing the riskiest paths — `medium`; patched (poll->receipt,
  wave NOT-MATCHED, handoff replay, HTTP idempotency-conflict/null-approval/
  404/arity, anchor validation, hash normalization, sanitization).
- `review-inputs-wave.test.ts` not classified heavy — `low`; rejected
  (observed 1-2 s against the 30 s fast ceiling; classification churn not
  warranted).
- Diagnostic lane scopes in the shared manifest contradicting "ONE scope" —
  `low`; patched (spec Code Map lists the durable scope + retained
  diagnostics).
- Shipped runbook without its repo-doc neighbours — `low`; rejected (the
  runbook is the deliberate operator deliverable; it stands alone and links
  the repo docs).
- Fallback `bmad-review` route silently dropped armed evidence — `high`;
  patched (named refusal before the fallback; no round, no drop) + test.
- `job-not-found` amendment refusal was unaudited — `medium`; patched + test.
- Verification gap: no test proves polled run URLs reach the receipt —
  `medium`; patched (github-poll -> renderRecordedCiEvidence test).
- Verification gap: no test proves the wave call site binds
  expectedRepo/expectedPr — `medium`; patched (second-round NOT-MATCHED wave
  test).
- Verification gap: no test proves evidence survives the queued handoff —
  `medium`; patched (handoff replay test asserts receipt/manifest/lead
  images).
- Verification gap: child-lens capability refusal unobservable — `low`;
  deferred (unreachable under the single review model; `deferred-work.md`).
- Verification gap: HTTP `idempotency-conflict` -> 409 unasserted —
  `medium`; patched + test.

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
- 2026-10-03: isolation run r10 (`review-inputs-regression`, run at 8e033f9)
  reproduced the `decisions.test.ts` hot-reload failure WITHOUT any of this
  lane's new suites in the scope (1 failed / 444 passed) — the failure is
  pre-existing and independent of this diff. All other eight files passed,
  including `dispatch-server.test.ts` and the seam suites. The final FULL is
  the gate for the final head; its result is recorded in the completion report
  and ledger (not rewritten into the head it proves).

### 2026-10-03 fresh-worker resumption (after disposal at 16:31:39Z)

- Reconciled the prior full-run line before any new submission: r12 green
  `55d7dea4` at `cea7bbf` (FULL ok, 1819 passed/12 skipped); merged `3c8e699`
  typecheck red; `13b8734` fix+typecheck+focused green; FULL `15bfc4a9` at
  `13b8734` RED with exactly two 30000 ms default-ceiling timeouts and zero
  assertion failures: `install-one-line.test.ts > restarts only an owned
  service…` (31324 ms) and `perkins-builtin-wave.test.ts > …(T4)` (37326 ms);
  1889 passed / 12 skipped / 2 failed (1903). Raw capture 153 frames
  (`queued`→`started`→`output`×150→`completed`), transport EOF clean, ledger
  start/completion seqs 43056/43110; decoded copy sha256
  `932864d2…b510a21` equals the producer's declared whole-output hash.
- No orphan producer existed: no `m7` capture file, no `m7` run in the ledger,
  no `review-input-handoff` slot or queued request in `scheduler.json`, and no
  argv/cwd/open-FD producer matching this lane. The prior author's intended
  quiet-window m7 loop is superseded by this resumption.
- Diagnosis (before any rerun): both failing test files AND `install.sh` are
  byte-identical between the green `cea7bbf` head and the red `13b8734` head
  (`git diff --quiet` per file); in the same window every untouched suite ran
  ~60% slower than at r12 (e.g. worktree-manager 332s→546s, wizard-interactive
  44s→70s) while the run queued 699 s behind other lanes; the lane's added
  per-round work is a bounded set of indexed ledger reads. Classification was
  therefore scheduled at the clean head, not a blind FULL replay: the existing
  `t4-oracle` scope plus a new additive `installer-isolation` scope (commit
  `68ce75c`; no test, timeout, assertion, budget or gate changed).
- Producer defect found and fixed while resuming: the first classification
  producer used `fetch`, whose default 300 s body timeout truncated the queued
  NDJSON stream (`streamError: terminated`). The server-side request was not
  cancelled: run `170e2be1` stayed queued and settled as a positively typed
  `verification.lock-timeout` (seq 43713, 19:10:28Z) — never started, no side
  effects; the reconciliation note is preserved beside the truncated receipt.
  The producer was rewritten onto `node:http` with no body timeout, and every
  sink is still pre-opened exclusively before the single POST.
- Classification evidence now recorded at the clean head `c08b7e1` (all runs
  via authenticated `/api/verify`, exclusive sinks, complete terminal + EOF,
  receipts under `review-inputs-verify-runs/`):
  - `installer-isolation` (run `0a8f8e6d`, receipts kept): **PASS** — the
    exact failing installer case ran in 18219 ms in isolation; 31 passed /
    4 skipped; whole-output sha256 `e35251ea…`. The m6 FULL timeout was
    contention, not a defect.
  - `t4-oracle` retry (run `7c189537`): typed never-started refusal
    (`verification.lock-timeout`, seq 43853, 900042 ms wait) — the queue was
    held by other lanes' long `full` scopes. T4 isolation classification is
    still open; it is folded into the next FULL attempt (if the FULL is green,
    T4 passed; if it reds on T4 again, the oracle is retried first).
  - `full` attempt (run `95f43be3`): RED at lint in 35.6 s — **a real,
    self-inflicted defect repaired**: the lane's newly written producer/helper
    `.mjs` scripts under `_bmad-output/…/review-inputs-verify-runs/` are not
    covered by eslint's ignore list (only `.gitignore` covers them), so
    `eslint .` failed on their Node globals. Repair: the helper tooling was
    relocated out of the repository tree to
    `~/.gru-command/investigations/review-input-handoff-tools/`; the runs
    directory keeps data artifacts only. No product or config file changed;
    the head stays `c08b7e1` for product content.
- Capacity note (exposed for ops, exact): the shared verify scheduler runs at
  `maxConcurrent=1`; on 2026-10-03 19:00–19:50Z other lanes' back-to-back
  `full` scopes held the single slot for ~30 min each and several requests
  (this lane's, pipeline-check's, others') hit the unchanged 900 s lock bound
  and refused cleanly (never started). Every refusal here is a positively
  typed `verification.lock-timeout` and the next attempt is separately
  accounted; capacity, not policy, is the constraint.

### 2026-10-04 owner-directed resumption, main integration and independent review

- Ownership reconciled before any edit: no live producer or session for the
  lane (the previous session ended 2026-10-03T20:57Z; the host service was
  SIGTERM'd at 19:57:31Z mid-`m11-full`, whose `verification.started` has no
  completion), clean tree, branch local-only, no PR. The interactive
  session took the lane.
- History-preserving merge of the then-current `origin/main` (`b9f83e1`) as
  `305fcdf`: conflicts resolved in `.gru-command/worktree.toml` (kept main's
  workload-aware scopes; the lane's `review-inputs` and
  `review-inputs-regression` scopes route classified heavy files through
  `vitest.heavy.config.ts`), `src/dispatch/perkins-review/whole.ts` (main's
  nullable specialist timeout kept alongside the evidence-image delivery),
  and `test/suite-shape.test.ts` (main's pins + the new suites).
  `installer-isolation` was routed through the heavy config at `7beb58f`.
- Full gate at `7beb58f`: `npm test` exit 0 — lint, typecheck, build, fast
  backend 1603 passed/6 skipped (99 files), heavy backend 669 passed/6
  skipped (29 files), web 440 passed (43 files); capture
  `review-inputs-verify-runs/m12-full-direct-7beb58f.log` (sha256
  e93cb70a9912837cd561ec3aad46dd978822cd5a7a13ff3bb47331b14c7ead25). This
  was a direct in-lane run because the host service was down; the scheduler
  run protocol is unchanged for the next lane.
- Three fresh-context independent review layers (blind hunter, edge-case
  hunter, verification gap) ran at `7beb58f` (raw outputs:
  `~/.gru-command/investigations/review-input-handoff-review-20261004/`).
  Triage is recorded above; patches landed at `b247de6`; two findings were
  deferred with rationale in `deferred-work.md`.
- Full gate at the patch head `b247de6`: `npm test` exit 0 — fast backend
  1612 passed/6 skipped, heavy backend 671 passed/6 skipped, web 440
  passed; capture `review-inputs-verify-runs/m13-full-direct-b247de6.log`
  (sha256 ea7b0abf1199a536b6b0703b4905f66f8ce57b20afe1536cba367b1dfbc76395).
- The final-head full gate after this spec update is recorded in the
  completion report and ledger (not rewritten into the head it proves).
- 2026-10-04: second history-preserving main integration (PR193,
  `origin/main` `e792768`) merged after the review patches as `e9c5b54`;
  conflicts resolved in `src/dispatch/perkins-review/whole.ts` (kept main's
  `sourceMovementSinceFreeze`/`SourceMovement` import alongside the
  evidence-delivery imports) and `test/suite-shape.test.ts`
  (`perkins-builtin-wave` 101 = main's 99 + this lane's 2). Focused suites
  (126 tests, 12 files) and the heavy seam suites (229 tests, 3 files)
  re-ran green at the merged head before the final full gate.
- The final-head full gate after this spec update is recorded in the
  completion report and ledger (not rewritten into the head it proves).

## Verification

**Commands:**
- `npm test` — full gate at the post-review patch head `b247de6` (direct
  in-lane run; host service down): exit 0 — lint, typecheck, build, fast
  backend 1612 passed / 6 skipped (99 files), heavy backend 671 passed / 6
  skipped (29 files), web 440 passed (43 files). Capture
  `review-inputs-verify-runs/m13-full-direct-b247de6.log`, sha256
  ea7b0abf1199a536b6b0703b4905f66f8ce57b20afe1536cba367b1dfbc76395.
  Full gate at `7beb58f` (pre-patch): exit 0 — 1603/6 + 669/6 + 440.
- Heavy seam suites at the patched head (`perkins-builtin-wave` 97,
  `perkins-whole-review` 81, `dispatch-server` 39): 217 green.
- Focused feature suites + guards at the patched head (9 files including
  `suite-shape` and `test-budgets`): 81 tests green.
- Pre-review scheduler evidence (superseded heads, preserved): scope
  `review-inputs` PASS (run ee48afd8 at f3959f5, 94/94 tests, whole-output
  sha256 b3675c9f2183c2d00c49fee7002379ebb2ac4e7381ace7c229a737528ac7b3b0);
  scope `review-inputs-regression` 444/445 at 8e033f9 (sole red the
  pre-existing `decisions` hot-reload timing, reproduced without this lane's
  suites).
- Final-head gate at the spec-updated head: recorded in the completion
  report and ledger (not rewritten into the head it proves).

**Manual checks:**
- `manifest.json`/`spec-context.md` of a frozen round contain no base64
  pixels, no upload source paths, and the acceptance/evidence blocks.
- Raw retained captures: `_bmad-output/implementation-artifacts/review-inputs-verify-runs/`.
