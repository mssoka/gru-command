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
  "idempotency_key": "<optional retry key>"
}
```

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

## 4. What freeze binds (audit trail)

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
  decision 2026-10-08). Each retry is durable: `round.admission-retry-
  scheduled`, then one transactional `-claimed` (a second runner on the
  ledger never runs it twice) and an `-outcome`, or `-skipped`. A restart
  resumes a scheduled retry, and reschedules one interrupted mid-dispatch.
  A retry is skipped, with an FYI, when the job moved on — a newer delivery
  or round, a non-reviewable status, a busy branch — re-checked after
  every wait of its own request. A fresh request refused while a retry
  stands takes that retry over (same attempt and due time). Only the last
  refusal escalates action-required. A git step that would not stop after
  SIGKILL ("cleanup unconfirmed") is never retried, and blocks every later
  review of that repository — across restarts too
  (`round.admission-cleanup-pending`) — until the group is proven gone.
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
rounds keep their mode and are exempt from the section check.

**Published reports carry the frozen CI state.** The host appendix of a
published review states the frozen CI evidence distinctly — `GREEN`,
`PENDING — NOT PASS`, `FAILED — NOT PASS`, `UNAVAILABLE — NO BOUND CI
RECEIPT (missing evidence, not a measured failure)`, or `NOT-MATCHED` —
derived only from the frozen manifest record, so missing evidence can never
read as a CI failure (and a measured failure is never softened).

## 5. Activating a previously blocked PR (owner-controlled, later)

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
   through the supported endpoints above. Merges, restarts and deployments
   stay owner-held.
