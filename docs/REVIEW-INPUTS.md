# Review-input handoff — operator runbook

Owner ruling j-969. Three review inputs travel one supported handoff into a
frozen Perkins round: **private evidence attachments**, the **exact-target CI
receipt**, and **approved canonical amendments**. This document is the operator
runbook; it describes the shipped mechanism only. Nothing here activates any
live PR or edits historical rounds.

## 1. Private evidence attachments

1. Materialize the private material through the existing attach flow (0700
   uploads dir, bounded media):

   ```
   POST /api/attach/uploads
   Authorization: Bearer <pairing token>
   { "filename": "reference.png", "content_base64": "<base64>" }
   ```

   The response's `path` is the service-managed upload identity. The path
   must be absolute and name a direct child of that uploads dir;
   subdirectories, symlinks and foreign paths are refused. Uploads are never
   copied into git, a review tree, PR comments, or logs.

2. Arm a review naming that identity (at most 4 attachments; PNG/JPEG/GIF/WebP
   only; 8 MiB per file, 16 MiB total):

   ```
   POST /api/dispatch/review
   Authorization: Bearer <pairing token>
   {
     "job_id": "...",
     "evidence": [{
       "upload_path": "<the uploads-dir path>",
       "purpose": "what this material is — say so if it predates the reviewed revision",
       "consent_ref": "<durable consent/approval reference>",
       "captured_at": "YYYY-MM-DD"
     }]
   }
   ```

3. At freeze the bytes are read once, magic-byte validated, hashed and copied
   to `<data_dir>/reviews/<round>/evidence/` with a private `receipt.json`.
   The frozen manifest records the attachment metadata. Review prompts receive
   the pixels through the capability-checked image transport; blind lenses
   receive neither text nor pixels.

**Fail-closed behavior.** Missing/empty/oversized/wrong-type material,
structurally invalid images (a bare signature with no image data),
traversal, symlinks (including a symlink swapped in between validation and
the read — the freeze opens the validated identity without following
symlinks), foreign paths, non-upload names, mutated frozen bytes (re-verified
at EVERY prompt delivery), or a text-only review model all refuse loudly. A
refusal is never replaced by a written description, and the round/turn does
not pretend the evidence was delivered. Check the review model's image
capability before arming: a round whose review model cannot accept images
freezes and then fails closed as INCOMPLETE naming the capability, so arm
evidence only for image-capable models.

**Queued handoffs.** A worker arm while its own lane is busy is queued with
its request (the durable `job.review-handoff-queued` payload carries the
service upload path so a restart can replay it — private ledger state only,
never a public artifact or log). The queue keeps the first-request identity: a
later arm with a different evidence set records `job.review-handoff-conflict`
with an opaque request fingerprint (no paths) and the queued request's
evidence is the one delivered; clearing a hold records
`job.review-handoff-superseded`.

**Retention and quota.** Uploads and frozen copies are private durable state.
The uploads dir is capped at 1,000 files (posting past the cap answers `507`
and names the dir to prune), and freeze copies each accepted attachment into
`<data_dir>/reviews/<round>/evidence/` alongside its receipt. Prune old
uploads through the existing attach/ops path when the cap is reached; frozen
copies stay with their round record.

**Honesty rule.** A purpose label must not claim the image was rendered at the
reviewed SHA when it was not. Reference material may predate the revision; the
frozen receipt includes capture time so readers can tell.

## 2. Exact-target CI evidence

No operator action is required. The GitHub poll records
`github.ci-green` / `github.ci-failed` / `github.branch-state` for tracked
lanes; at freeze the host binds the latest observation to the exact
repository/PR/SHA and renders it into the frozen spec context (beside, and
distinct from, the local scheduler verification block) and into the manifest.

- GREEN/PENDING/FAILED render the recorded state with check names/URLs,
  observation time and source event (kind + seq). A host string that lands in
  the block has control characters/newlines collapsed first, so no check name
  can forge a block boundary.
- A stale SHA, wrong repository/PR, a PR-less observation standing in for the
  expected PR, malformed payload or check list, or absent observation renders
  an explicit `UNAVAILABLE` / `NOT-MATCHED` limitation — never a PASS and
  never a fabricated failure. A job with no resolvable PR URL renders
  UNAVAILABLE: a receipt cannot be repository-bound, and an unverified
  observation is never rendered as one.
- The latest recorded observation at the target SHA governs: a newer
  observation carrying no usable CI result (no check runs yet, malformed
  payload) degrades to an explicit UNAVAILABLE and never falls back to an
  older green.
- A CI block too large for the frozen spec bound renders an explicit
  `UNAVAILABLE — CI EVIDENCE OMITTED` notice; if even that notice cannot
  fit, the freeze is refused rather than shipping a spec with no CI
  limitation. The structured record stays in the manifest.
- Frozen rounds stay historically stable; late results do not rewrite them.

## 3. Approved canonical amendments

Amendments are append-only and versioned. The original briefing is never
rewritten; later rounds render the effective acceptance, earlier rounds keep
their frozen record.

Read the current contract (version, both hashes, full effective text, and the
accepted amendments):

```
GET /api/dispatch/jobs/<job_id>/contract
Authorization: Bearer <pairing token>
```

Returns `version`, `base_sha256`, `contract_sha256`, `effective_contract` and
an `amendments[]` array (`id`, `version`, `created_at`, `body_sha256`,
`supersedes`, `approval`, `previous_contract_sha256`, `contract_sha256`).

Append an approved amendment:

```
POST /api/dispatch/amendment
Authorization: Bearer <pairing token>
{
  "job_id": "...",
  "body": "the accepted amendment text",
  "supersedes": ["original:Acceptance 1", "amendment:<id>"],
  "approval": { "by": "owner", "reference": "epoch12 seq194760 client_msg_id ..." },
  "expected_contract_sha256": "<the hash you just read>",
  "effect": "material",
  "idempotency_key": "<optional retry key>"
}
```

- `effect` is required (owner rule 1, 2026-10-08):
  - `"material"`: the approved change requires implementation. It raises the job's
    required work revision to this amendment's version, makes the delivered candidate
    outdated, and supersedes any review of it (see §4).
  - `"administrative"`: a clarification, typo or bookkeeping update. It never restarts
    work and never blocks review.

  A request without a valid `effect` is refused (`400`) and audited. Amendments accepted
  before the field existed stay unclassified (`effect: null`). They render exactly as
  before, so frozen contract hashes do not move, and they never gate review.
- The response carries `work_revision` (`required`, `delivered`, `pending`) and
  `review_supersession` (`"started"` when a material amendment found a review owning the
  lane, otherwise `"none"`). `GET /api/dispatch/jobs/<id>/contract` returns the same
  `work_revision` block and each amendment's `effect`.

- `expected_contract_sha256` is optimistic concurrency: a stale or concurrent
  writer is refused (`409`) with the current hash/version and the refusal is
  audited (`job.amendment-rejected`). A `job-not-found` request answers `404`
  and is audited too.
- The same `idempotency_key` + same request retries deterministically; a key
  reused for a different request answers `409` (`idempotency-conflict`).
- Each acceptance is audited (`job.amendment-accepted`) with amendment id,
  version, body hash, approval provenance and contract hashes.
- Bounds: `body` ≤ 32 KiB UTF-8; `supersedes` ≤ 32 entries, each
  `original:<anchor>` (the anchor must occur in the original briefing — a typo
  is refused) or `amendment:<id>` (an already-accepted amendment id); the
  rendered effective contract ≤ 192 KiB. `400` for malformed/
  improperly-authorized requests (a blank or missing approval reference is
  refused); terminal jobs and jobs without a recorded briefing take no
  amendments. Every authenticated refusal at the amendment boundary is
  audited (unauthenticated attempts answer `401` without ledger writes),
  including an unreadable request body.

**Authorization honesty.** The service's paired bearer token is the only
authentication primitive. `approval.by`/`reference` are recorded provenance,
not an identity system — never accept an amendment whose reference does not
resolve to a real owner decision, and never treat a repository document or a
worker/caller-declared role as approval.

## 4. Supersede-and-resume (owner rules 2026-10-08)

The sequence is implement → verify → review → READY → owner merge. A material amendment
accepted during review becomes: supersede the review → confirm it stopped → implement the
latest revision → verify → fresh review. The service enforces it centrally.

- **Work revision.** The *required* revision is the highest material amendment version.
  Every continuation request records the required revision it was composed with: the
  directive intent (`work_revision`, echoed on the 202 and the readback), the re-brief
  marker, and the dispatch turn (always 0). The `job.delivered` that settles the request
  carries `work_revision`. That delivery is the revision's acknowledgement. The prompt also
  names the revision, but a text echo alone never counts.
- **One continuation.** While delivered < required, the next directive or re-brief carries
  every pending material amendment's canonical text once, in version order. Each request
  is stamped with its revision. A fresh minion (re-brief, or the resume fallback) is briefed
  with the full effective contract, not only the original briefing. Silas's digest owes ONE
  continuation (`revisionContinuations`, rule `revision-continuation`) while no writer owns
  the lane.
- **Pending corrections fence review.** The shared branch-idle predicate treats
  delivered < required as busy, so every route refuses:
  - arm and freeze;
  - queued handoff;
  - fallback admission;
  - automatic admission retry.

  The `409 branch_busy` blocker carries `required_revision`/`delivered_revision`. A review of
  an explicit `target_ref` cannot bypass the job's own fence, and neither can `force`: like
  an open retirement hold, a pending correction is never an overridable blocker. That holds
  at the arm, at the freeze recheck, and at the fallback gate's admission and iteration
  boundaries.
- **Corrective deliveries are verified before review (owner decision 2026-10-09, option A).**
  The first delivery that carries a new work revision owes a passing scheduler verification
  (`verification.completed` with `ok: true`) on its exact delivered head. Any scope the lane
  declares counts. Until that pass exists, the lane stays busy: the blocker carries
  `verification_required_head`, and the digest offers `verificationsOwed` instead of a
  review row. A repair after a failed run owes its own pass. Once a review round has
  admitted the corrected work, later ordinary deliveries keep today's behavior (no
  verification may be in flight). This debt is a busy fact, so owner `force` may override
  it; it never overrides a pending revision. A pass re-offers a review request that was
  waiting on it. An active `dismissed` decision for `verification-failure` on
  `job:<id>`, bound to the exact `verification-failure:<scope>@<run_id>` basis,
  retires that run's repair attention only. Independent scopes retain their own
  exact dispositions, but a newer ANY-basis `verification-failure` decision fences
  older exact dismissals; an ANY-basis dismissal cannot retire a specific run.
  Cleared or expired exact decisions and newer failures reopen repair.
  When no unresolved same-head repair remains, the full Silas digest still offers
  `verificationsOwed`. Dismissal never rewrites FAILED receipts or grants review:
  the unchanged corrective-verification gate remains until eligible proof exists.
- **Onboarding heists are reviewed only on a proven head (#427 PR 1b).** A job an
  `onboarding.dispatched` event names owes a passing `onboarding.proof` on its newest
  delivered head: GC clones that head, applies its manifest, runs `verify.full` under the
  verification budget, and measures it ([ONBOARDING.md](./ONBOARDING.md#proof-before-review)).
  The head is read as the corrective-verification gate reads the newest delivery: one that is
  not a proven current candidate, or whose sha is not a full commit id, identifies no head, and
  review waits for the minion's next delivery. The first proof of a head stands, and a record
  the one proof reader cannot read is never a pass. Until it passes, the lane is busy on every
  route the corrective verification fences (arm, freeze, queued handoff, fallback admission
  and iteration, the Silas review offer); the blocker carries `onboarding_proof_required_head`
  (null when there is no head) and `onboarding_proof_reason` (`no-delivery`, `no-commit`,
  `unproven`, `failed`, or `uncommitted`). The exact commit under review must pass too: an arm
  that names a target is refused at the arm with a `409` before any round exists (an arm with
  no target reviews the live PR head, never a commit left unpushed in the lane); the freeze
  checks the exact sha it reviews last (a live PR head pushed after the delivery); and the
  bmad-review fallback, which reviews the lane's working tree, needs a passing proof of the
  lane HEAD and a lane with no uncommitted changes the proof never ran (tracked edits or
  untracked files git does not ignore, leaving out the `[[link]]` and `[[copy]]` paths the
  lane's bootstrap placed while each is still what it placed: a link whose real path is the
  manifest target's, a copied file whose bytes equal its source's in the repository checkout
  now; a copy whose source changed since the lane was made is refused, naming it), at
  admission and at each iteration. A link target or copy source the repository checkout
  cannot give (gone, unreadable) refuses at admission and aborts a running gate with `code:
  "onboarding-source-unreadable"`, a reason naming it, and a hint that the owner must fix the
  checkout. A gate that stops at an iteration for this (its fix left an unproven lane HEAD, a
  new unproven delivery, or uncommitted changes) aborts with `code:
  "onboarding-proof-required"` and a hint: the minion commits, pushes and delivers the fix, GC
  proves the new head, and once that proof passes the Silas digest offers the review again; a
  self-review request made after the fix was delivered is queued and replayed on that pass
  (nothing replays the aborted gate itself). Like a pending
  correction, `force` never waives it, and the `409 branch_busy` hint says so (or says the
  minion must deliver again, has not delivered yet, or must commit or discard its lane's
  changes). Every `branch-idle.refused` audit records `forced` (force was
  applied: blockers waived) and `force_requested` (the request asked for force), so an
  onboarding refusal under force records `forced: false, force_requested: true`. A worker's own
  review request is queued and replayed on the `onboarding.proof` event, also after a restart.
  The proof is never verification evidence (no `verification.*` event exists for it,
  `POST /api/verify` refuses the reserved `onboarding-proof` scope with `400 reserved_scope`,
  and a manifest that declares that scope is refused by name). When the proof's head is the
  reviewed sha, the frozen packet carries an `ONBOARDING PROOF` block between the recorded
  verification and the CI evidence; every minion-written field in it is one line that cannot
  carry the block's end marker. The block, or its omission notice, never takes the room the CI
  section needs: the CI block's when that block fits on its own, else the CI omission notice's.
  A block that does not fit freezes as an omission notice; a notice that does not fit beside
  the CI block still freezes beside the CI omission notice, which the CI section then renders.
  Only when the notice fits beside neither is the freeze refused, naming the section that did
  not fit.
- **A historical-only delivery owes a current inspection (owner decision 2026-10-16, #361).**
  When a job's newest delivery is history (a completion recorded without proving a current
  candidate) while a corrective verification or a contract revision is still owed, no
  verification, continuation or review row can name its candidate. The Silas digest offers a
  `currentInspections` row instead: Silas inspects the lane head and asks the minion, with one
  `current-inspection` directive, for a proven current delivery. The row never restores
  review eligibility; the lane stays busy until that delivery owes and pays its own gates.
- **Supersession.** Accepting a material amendment supersedes any review that owns the lane.
  A queued round is withdrawn, or a running round and its specialists are cancelled.
  `round.superseded` is recorded first, with the settled specialist checkpoints. Partial
  findings stay in the round's artifact directory. The stop is then *confirmed*:
  - every review operation settled within the bound;
  - every round is terminal;
  - no review session still holds a live runtime handle.

  The stop is proven the same way the next round's setup proves a predecessor stopped: a
  trusted no-spawn receipt, or the runtime proving the round's owner marker and every
  registered session ceased. Startup recovery writes that receipt for a round that never
  went live (#466), so a restart that interrupted the supersession of a round still in setup
  re-proves it without the runtime. A superseded fallback gate's reviewer sessions are proven too;
  its debt lives on the job (`job.review-superseded` / `job.review-supersession-*`). The outcome is recorded as `round.supersession-confirmed`, or as
  `round.supersession-unconfirmed` plus one action-required escalation. A round whose stop
  stays unproven keeps owning the lane, even though it is terminal: every later writer
  re-proves it before prompting. A supersession with no newer confirmation (for example
  after a restart interrupted it) counts as unproven. A failed re-proof of an
  already-escalated stop is an FYI, not a second alert. A superseded round records `round.perkins-incomplete` with
  reason `superseded`. That is routine FYI, never an Ack, including after a restart that
  interrupted it, and it is never a clean-abort re-arm candidate.
- **Queued review requests.** A review request queued before the material change (a
  handoff waiting for delivery) asked for the obsolete candidate. It is withdrawn durably
  (`job.review-handoff-withdrawn`), so neither the corrective delivery nor a restart replays
  it. Any queued request older than an accepted material amendment is treated as withdrawn,
  even if a crash lost the withdrawal. A new request for a candidate that a pending revision
  already made obsolete is refused rather than queued. The corrected candidate is reviewed through the ordinary rows. A superseded fallback
  gate stops at its next decision point and records `aborted` with `superseded: true`; it
  never records a late PASS or sends a fix directive.
- **Writer gate.** Before a directive or re-brief prompts the lane's minion, the service
  supersedes and *proves stopped* every review that owns the lane.
  - **Unproven stop.** The writer is refused and nothing is sent. A directive records a
    positive no-effect failure; a re-brief answers `409 review_supersession_unconfirmed`
    before any marker exists.
  - **Review running, no material revision pending.** The branch stays frozen: directives,
    re-briefs and provider-recovery claims answer `409 review_in_progress`. A
    provider-recovery claim on a lane whose review a material correction made obsolete
    takes the same supersede-and-prove gate first.
  - **One writer per lane.** A directive while a re-brief stands, or a re-brief while a
    directive is live, answers `409 writer_conflict`.
- **READY binds to the reviewed contract.** The board withholds the owner-ready (merge)
  offer in two cases: while a material correction is pending delivery, and when the
  approved round froze an older contract than the required revision. An administrative
  amendment never withdraws READY. A correction retracted after it superseded a review
  re-offers the standing delivery for review. A superseded review answers no review
  request.
- **Restarts.** Boot recovery terminalizes live rounds. The writer's durable intent (the
  directive row or re-brief marker) keeps fencing review until it settles.

## 5. What freeze binds (audit trail)

Every frozen round records:

- `manifest.acceptance`: contract version, base/effective hashes, amendment
  ids — present only when the round froze a spec (`no_spec` rounds have none).
- `manifest.reviewEvidence`: frozen attachment metadata (possibly empty) and
  the CI record; always present because the CI record is explicit, including
  `UNAVAILABLE`/`NOT-MATCHED` when nothing binds.
- A `round.review-inputs-frozen` ledger event with the same hashes/provenance
  (no pixels, no upload paths).
- A `round.admission-preflight` ledger event (gh-169): the read-only gate
  that ran after the freeze and BEFORE any lead or child spawn. Its payload
  carries `ok`, the complete check list, and on refusal the exhaustive named
  missing inputs (`head-binding`, `frozen-packet:<file>`, `spec-context`,
  `verification-evidence`, `ci-evidence`, `evidence:<id>`). A refused round
  aborts without spawn and escalates naming every missing input; fully
  accessible material passes and the packet stays frozen head-bound. A
  TRANSIENT refusal — every missing input a `head-binding` git step that
  failed and PROVED its whole process group stopped (`retryable: true`) —
  instead retries on its own, 1 minute and then 5 minutes later (owner
  decision 2026-10-08). Retries live in memory: when one is due, a single
  check confirms the job is where it was refused, then the same request
  (never its `force`) runs as an ordinary review request with every
  ordinary fence. A newer delivery or round, a non-reviewable status,
  another request under way or a busy branch skips it with an FYI. A fresh
  request refused while a retry waits keeps that retry (same attempt and
  due time). Only the last refusal escalates action-required. Nothing
  resumes a retry after a restart: one still pending escalates
  action-required once at the next start (`round.admission-retry-
  scheduled` / `-settled` are bookkeeping for that check only). A git step
  that would not stop after SIGKILL ("cleanup unconfirmed") is never
  retried: the round is refused and one action-required alert names the
  still-running process group — nothing is quarantined (owner decision
  2026-10-08). Every review git step runs with the repository-routing
  environment (`GIT_DIR`, `GIT_WORK_TREE`, …) removed.
  Missing
  evidence never refuses admission by itself: an explicit UNAVAILABLE CI
  record is a PASS at preflight (its missing-vs-failed distinction is a
  display/report duty — see §2); only inaccessible, corrupt or unbound
  material refuses. The preflight is read-only: packet bytes are never
  mutated by admission, display or recovery code.

The frozen `spec-context.md`, `manifest.json` and `evidence/receipt.json` are
host files under `<data_dir>/reviews/<round>/`; there is no public read
endpoint for them — operators inspect them on the host.

**Verification absence is explicit (gh-169).** A supplied-spec round with no
completed scheduler verification run bound to the frozen target freezes an
`UNAVAILABLE — NO BOUND VERIFICATION RUN` section beside the spec (the same
ledger-backed, untrusted-evidence framing as a real run) — never silence. A
spec with no room for that disclosure refuses the freeze. Explicit no-spec
rounds keep their mode and are exempt from the section check. The host
searches the job's COMPLETE `verification.completed` history newest-first in
bounded pages (no finite per-job lifetime window): the newest run binding
the frozen target governs, and the explicit absence section is rendered only
after that search exhausts the history. A read that fails mid-history aborts
the freeze loudly (no spawn) instead of rendering UNAVAILABLE — unreadable
evidence is never fabricated absence.

**Published reports carry the frozen CI state.** The host appendix of a
published review states the frozen CI evidence distinctly — `GREEN`,
`PENDING — NOT PASS`, `FAILED — NOT PASS`, `UNAVAILABLE — NO BOUND CI
RECEIPT (missing evidence, not a measured failure)`, or `NOT-MATCHED` —
derived only from the frozen manifest record, so missing evidence can never
read as a CI failure (and a measured failure is never softened).

## 6. Activating a previously blocked PR (owner-controlled, later)

This lane ships the mechanism only. When the owner chooses to supply evidence
or amendments to an existing PR:

1. Re-check the live head, ownership and gates first — historical reviewed
   heads are not clearance.
2. Materialize the evidence upload, read the current contract hash, then arm a
   **new** review round (never edit old manifests/specs/verdicts). The new
   round freezes the effective acceptance and evidence; old rounds are
   untouched.
3. For PR165-style renamed-skill corrections, append the approved amendment
   with its real provenance reference, then freeze a new round.
4. Existing pending source/control records are never replaced; re-arm only
   through the supported endpoints above. Final PR merges, restarts and
   deployments stay owner-held.

## 7. Blind-review input isolation (issue #316)

A clean checkout and a reproducible diff are not proof that a blind reviewer
stayed blind. Root cause of the repeated invalid rounds: the child's briefing was
free-form text the parent composed from its ORIGINAL contract; commissioning
never consulted the parent's EFFECTIVE contract (amendments, administrative
clarifications included), never inspected the input the child would receive, and
report settlement (`delivered`/`done`, disposition `acted`) was the only
lifecycle fact — so a settled report read as independent coverage.

`POST /api/dispatch` with `deliverable: "review"` now carries:

- `review_role`: `"blind"` (isolated input) or `"claims"` (a reviewer that
  legitimately needs claims, a separate contract). Omitted: a lane titled
  `blind` is blind, anything else stays unclassified and untouched (historical
  bindings unchanged).
- `input_package`: `{base_sha, target_sha, diff?: {text, sha256?},
  files?: [{path, content, sha256?, blob_sha?}]}`. Validated BEFORE any job row,
  worktree or reviewer exists. Refused with `422 blind_input_refused`, the
  exhaustive violations (never the private text) and a correction path when it
  names private job material (`_bmad-output/**`, `docs/issues/**`,
  `investigations/**`, `.gru-command/{jobs,reports,reviews,artifacts,journal}/**`,
  plus anything the parent excludes), carries task-spec / prior-assessment /
  deferred-work / triage text in a document-like file (extensionless or
  `.md`/`.markdown`/`.txt`/`.rst`/`.adoc`), or embedded in a larger such document
  (structure-anchored). Other file types are not content-scanned: they are
  judged by path only, and a source line merely mentioning a planning path is
  not exposure. It is also refused when it mismatches its declared digests or git
  blob ids, or targets another sha. An unfiltered diff is judged per file section
  (git's C-quoted `diff --git "a/…" "b/…"` headers included, every `./` and empty
  segment normalized, and a document renamed to a source extension still judged by
  its text). A diff the gate cannot read — an empty text, prose, lines before the
  first header, an unreadable header, or any line inside a section outside git's
  own grammar (extended headers, then hunks holding exactly the lines their headers
  count: prose, a `diff --cc` line, a hunk overrun or cut short, a binary patch, a
  rename/copy/`---`/`+++` line naming another path than the header) — is refused
  as `unparsed-diff`: a diff that judged nothing admits nothing (#360). An
  unquoted header naming one path twice is split at its middle, so a path holding
  ` b/` is read whole; a rename header is split only by its own rename lines.
- **Bound to the target (#360).** The review-source preflight (always wired by the
  service) binds the package: it must name the verified target and a base that is
  in the object store and an ancestor of the target; every file must be the target
  tree's own blob at that path; every path its diff names must be one
  `base..target` really changes; and every line a hunk shows must be that file's
  own line where the hunk header says (removals and context at the base, additions
  and context at the target). Anything else is `unbound-package`. Self-consistent
  digests alone bind nothing. With no preflight wired, a blind package is refused
  by name (an embedding may opt out with `allowUnboundBlindPackages`, which only
  test harnesses set). Coverage is admitted under the
  RESOLVED target, so an abbreviated `target_sha` never splits already-owned coverage.
- **Delivered (#360).** The admitted package is the reviewer's input: its briefing
  carries a `BLIND INPUT PACKAGE` block with the exact diff and files, fenced and
  framed as data (a package file path holding a control, format — bidi,
  zero-width — separator, private-use or unassigned character is refused, so
  nothing can escape a fence or disguise its heading). A refusal's text names
  every path as a JSON literal with each line-unsafe character escaped. A
  violation's `where` (and a recorded read's `path`) holds a line-safe path as
  written, and any other path as that literal. A path that itself opens with
  `"` counts as "any other", so a leading quote always marks the escaped form.
  The package bytes are kept (`review.blind-input-package`, written before the
  admission), so a fresh
  replacement reviewer spawned by provider recovery gets the same block; a resumed
  session already holds it. An attested reviewer whose package was not kept (one
  admitted before packages were kept) fails that fresh continuation by name —
  never a replacement briefed without its input.
- **No claims (#360).** `required_inputs` (claims inputs) on a blind reviewer are
  refused as `claims-input`; a reviewer that needs them is `review_role: "claims"`.
- **Role-specific host context.** The durable admitted role is checked before
  provider prompt construction. A blind reviewer receives no automatic Book of
  Lessons lookup, chapter pointer or other GC-injected out-of-package reading
  obligation, on initial dispatch, native directive continuation, fresh
  re-brief or provider-recovery-created fresh session. Fresh blind sessions keep
  the admitted frozen package/source; the role boundary filters lesson pointers
  before rendering as well as at the renderer. Ordinary workers and `claims`
  reviewers continue to receive the generic lesson references. This does not
  alter native runtime, credentials, workflow authority, package attestation or
  observed-access checks.
- `parent_contract_sha256`: the parent contract hash the package was built
  against. A stale hash answers `409 stale_parent_contract` with the current hash.

The parent's effective rule comes from `blind-isolation:` lines in its briefing
or any still-effective amendment: `exclude <glob>`, `permit <path>` (lifts an
exclusion for versioned `.toml/.json/.yaml/.yml` config only, never private job
material) and `require-package`. A malformed directive fails loud.

A valid package records `review.blind-input-admitted` with the rule digest, the
parent contract version/hash and package provenance (base/target sha, per-file
sha256 and git blob id, diff digest and paths). A refusal records
`review.blind-input-refused`.

**Validity is not settlement.** `GET /api/dispatch/jobs/<id>/blind-coverage`
answers `qualifying | invalidated | unattested | unobserved | not-blind | unclassified`,
derived only from the admission, `review.blind-access-observed` and
`job.blind-access-unobservable` facts. The reviewer's session tool results are
scanned at turn settle (grep lines landing in excluded paths, paged reads
returning history-bearing text, and any file-content tool call — pi `read`/`edit`,
Claude `Read`/`Edit`/`MultiEdit`/`NotebookRead`/`NotebookEdit`, and a content
search (pi `grep`, Claude `Grep`) — whose result returned, even empty or binary,
for a path that is excluded, however its bytes look. A call is judged by the path
it names: an absolute path inside the job's lane by its repository path, one
outside the checkout as outside the package, and the repository root itself as no
file. A path inside the checkout is access exactly when it matches an excluded
glob; a directory that matches none (the usual case — `docs/issues` does not match
`docs/issues/**`) leaves the search judged by the paths and text its output shows,
as every listing (`Glob`, `find`, `ls`) is). A settled session whose
transcript cannot be read at all (absent, unreadable or over the size bound)
records `job.blind-access-unobservable` once while it stands — never an empty,
clean-reading observation — and its coverage is `unobserved`, not qualifying,
until a LATER scan of that same session reads it; another session's read, an
earlier read or an operator post never supersede it. A turn with no transcript
at all has nothing a later scan could read, so its job stays `unobserved`: what
that turn read is unknown, whatever came after (#360). And
`POST /api/dispatch/blind-access {job_id, tool_results:[{tool_name?, text}]}`
records a LATER read. Any prohibited observation makes the coverage
`invalidated`; the report, its findings, its status and its disposition are left
exactly as recorded (no replay, no debt revival and no binning or revival of a
terminal report). A blind commission for a target whose blind coverage is
already `qualifying` under the same parent answers `409 blind_coverage_owned`
naming the job to reuse (or `409 blind_coverage_unreadable` naming a sibling
whose recorded blind-access facts cannot be counted — repair them in the ledger
first). After prohibited access has invalidated a terminal report, the existing
API permits a fresh blind commission for that same parent and target; its new
admission records the replaced sibling. The old report remains preserved and
invalidated and never counts as blind coverage.

