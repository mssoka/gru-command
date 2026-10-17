# Native GC intake: review and explicit approval

GitHub issues, Markdown/plain-text specs, and BMAD epics, stories, v7
`tickets.toml` breakdowns and architecture documents enter one immutable GC
proposal. BMAD is optional **source data**, not a runtime. No BMAD
installation, model, new session, scheduler or credentials are required for a
preview. Gru can supply a structured refinement from the existing conversation,
and the owner can ask a planning minion to slice an epic that has no breakdown
([below](#slicing-an-epic-with-a-planning-minion)).

**Preview creates zero executable work:** no jobs, minion dispatches, lanes,
pipeline entries, or held entries. Imported commands, labels, statuses,
frontmatter and model output cannot approve execution. Only an explicit
revision/selection approval enters the existing pipeline. Nothing here changes
Perkins, owner approval or merge authority.

## Sources and identities

Always supply `repoPath`: the exact canonical absolute root of a repository in
the configured managed workspace registry (`managed_repos` in the instance
config). A sibling under `workspace_root` that is not listed there is not an
intake repository. Cwd, basename guesses, aliases and cross-project reads are
not accepted. Each logical `intakeId` has immutable
`requestId` revisions (lowercase letters/digits, dot, underscore or dash,
1–128 characters, starting with a letter/digit).

- `issue`: `reference` is `#296`, `owner/repo#296`, or an exact
  `https://github.com/owner/repo/issues/296` URL on the selected repository's
  supported GitHub origin. Credentials, ports, query strings, fragments,
  foreign hosts/repositories and pull requests are refused. The configured
  `gh api` credentials and bounded argv/timeout transport are reused.
  `commentIds` selects at most seven supporting comments explicitly; nothing
  enumerates or follows comments/links. Returned identities are checked. A
  `GhRateLimitedError` stops the batch: each remaining selected comment becomes
  `intake_supporting_source_unattempted`, never an invented snapshot. The intake
  transport caps stdout at 256 KiB and stderr at 4 KiB, with the existing
  30-second timeout and credentials/host policy. UTF-8 is decoded once from
  captured byte chunks, so split codepoints retain exact hashes. Shared runner
  defaults remain 16 MiB output/stderr and 30 seconds.
- `spec`: `document` names a repository-relative `.md`/`.txt` `path` or an
  explicit service-managed `uploadPath` from the existing attach flow.
- `bmad`: the same document shape, but Markdown only, plus at most one
  document named exactly `tickets.toml` (an upload keeps its original name):
  a v7 epic folder's breakdown ([below](#bmad-v7-epic-folders)). Explicit
  `supporting` documents supply stories and architecture; story links are never
  followed. Unprovided story
  links and unavailable supplied documents remain named gaps. Frontmatter and
  raw header bytes are retained verbatim as data, not configuration or authority.
  Inline and ordinary full/collapsed/shortcut reference-style story links support
  `.md`/`.MD`, fragments and Markdown titles. Only a successfully captured explicit
  document satisfies a destination; a listed but unreadable path does not.
  Identifying frontmatter is parsed after an optional BOM without changing bytes.
  The supported `id`, `epic`, `epic_id`, `story`, `story_id`, `title`, `status`
  scalar subset is plain alphanumeric text with spaces/dot/underscore/slash/dash,
  or simple single/double-quoted strings without escapes. Collections, aliases,
  multiline/nested/duplicated fields and ambiguous scalars (including unquoted
  booleans/null) yield `intake_identifying_metadata` questions and no guessed
  identifier. This is deliberately not a universal YAML parser.

Markdown story-reference recognition ignores fenced/inline code examples only
for link detection; raw bytes and all bounded requirement traces stay unchanged.
Valid percent-encoded filenames are decoded before matching successfully captured
explicit stories. Malformed encodings, foreign hosts/paths, and encoded traversal
or path separators remain named questions (`intake_unsafe_story_reference`); no
link authorizes crawling. Identical gap identities (code, locator, question) are
stably deduplicated without dropping source bytes or requirement lines. Empty
LF/CRLF frontmatter, with or without a BOM, closes normally; genuinely
unterminated headers remain questions with exact raw/header bytes preserved.

A request supports one primary source and at most seven supporting documents
or comments. File sources are bounded, regular UTF-8 files (256 KiB each),
without symlinks, hardlinks, traversal or path aliases. Descriptor reads check
inodes and mutation. BOMs, CRLFs and frontmatter stay in the captured bytes.
Snapshots retain exact response/file text, locator, revision and SHA-256;
issue planning text is title plus body. Invalid JSON issue responses are retained
as data when bounded and strictly UTF-8 representable. Invalid UTF-8 transport
produces a named gap with the request retained, never a fabricated snapshot or
requirements. Valid BOM/multibyte bytes remain exact. Empty/whitespace-only issue
content gets a direct `intake_incomplete_issue` question, never a guessed goal.
Missing/denied sources are never guessed.

Captured raw source bytes have a **1 MiB (1,048,576 bytes) aggregate planning
limit** and the inventory has a **4,000 nonblank-line limit**. Proposal and diff
JSON outputs have a **2 MiB (2,097,152 bytes) limit**, including repeated raw/text,
quotes/traces and JSON escaping. Serialization stops on output amplification
before proposal publication or an HTTP response; nothing is silently truncated.
Exceeding these limits returns a named `413 intake_aggregate_bounds`,
`intake_source_bounds` or `intake_output_bounds`. The explicit request, exact
capture and named failure remain private; no proposal is published. Capture
retention includes every bounded explicitly captured input. Inventory construction
allocates at most **4,001 entries** (the 4,000-line limit plus one overflow
sentinel); overflow retains a named diagnostic gap stating that this inventory
is a capped prefix, not a complete requirement inventory. All remaining exact
source lines stay in the snapshots; planning refuses before a proposal is built.
Narrow sources/refinement using a new request identity. An oversized diff is refused without altering either
immutable revision.

## Authenticated API

Every `/api/intake` route requires the existing pairing token. An instance
without this optional service returns `503 intake_not_hosted`. POST bodies are
limited to 512 KiB (`413 intake_invalid_request`); the named response is flushed
before the overflowing connection is terminated, including unfinished chunked
senders. Read/diff URLs are limited to 8 KiB. Malformed percent-encoded path
identities return named `400 intake_invalid_request`, not an internal failure.
JSON serialization accepts at most **64 nested containers**, counted from the
complete request root; deeper valid JSON returns `400 intake_invalid_request`
before preview storage allocation. Valid canonical bytes/order are unchanged.
Read/diff only open existing contexts: absent contexts/revisions return named
`404 intake_not_found` without private-tree writes. A missing binding on a
nonempty context, damaged recorded bytes, or either orphan side of a payload/
receipt pair returns `intake_storage_error`, never a concealed not-found. Exact
POST retry recovers receipt-before-payload interruption; a lost receipt requires
restoration of the exact original receipt, not guessed provenance.
Preview, revision, read, diff, review and rejection never enqueue. The separate
explicit approval boundary uses the existing pipeline service.

```bash
curl -H "Authorization: Bearer $PAIRING_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repoPath":"/workspace/demo","intakeId":"feature-296","requestId":"r1","source":{"kind":"issue","reference":"#296","commentIds":[]}}' \
  http://localhost:3000/api/intake/preview
```

Document source examples (replace the `source` in the same request):

```json
{"kind":"spec","document":{"path":"specs/intake.txt"}}
```

```json
{"kind":"bmad","document":{"path":"planning/epic.md"},"supporting":[{"path":"planning/story-1.md"}]}
```

```json
{"kind":"spec","document":{"uploadPath":"/configured/private-home/uploads/1791633600000-11111111-2222-3333-4444-555555555555-spec.txt"}}
```

`POST /api/intake/preview` returns a proposal with `executable: false`,
`projectKey`, `intakeId`, `requestId`, content-derived `revisionId`, verified GC
workflow identity, snapshots, requirements, gaps and a validated `plan`.
Source gaps return a non-executable proposal, even when there are no heists.
The original request is retained before source reads; invalid plans return a
named error and retain the request, capture and failure without a proposal.

Read a completed revision:

```bash
curl -G -H "Authorization: Bearer $PAIRING_TOKEN" \
  --data-urlencode 'repoPath=/workspace/demo' \
  http://localhost:3000/api/intake/feature-296/requests/r1
```

An identical retry converges. Changed source bytes/revision, workflow identity,
request or plan under the same `requestId` returns `409 intake_replay_conflict`.
Refresh with a **new** request id and optional `previousRequestId: "r1"`.
Previous revisions and historical bindings are never rewritten. Missing
completed revisions return `404 intake_not_found`.

```bash
curl -G -H "Authorization: Bearer $PAIRING_TOKEN" \
  --data-urlencode 'repoPath=/workspace/demo' \
  --data-urlencode 'from=r1' --data-urlencode 'to=r2' \
  http://localhost:3000/api/intake/feature-296/diff
```

Diffs show old/new snapshot and heist changes, gaps, questions, unmapped
requirements and workflow identities. They remain non-executable.

## BMAD v7 epic folders

In BMAD v7 an epic is a folder: `epic-<slug>/epic-<slug>.md` plus a
`tickets.toml` whose `[[entry]]` tables, in build order, are its agreed slices.
Supply the epic as the primary document and the `tickets.toml` (and its
architecture, below) as supporting documents. The breakdown must sit beside the
epic, in the same folder; uploads, which carry no folder, are exempt:

```json
{"kind":"bmad","document":{"path":"_bmad-output/epic-cart/epic-cart.md"},"supporting":[{"path":"_bmad-output/epic-cart/tickets.toml"},{"path":"_bmad-output/architecture-checkout/architecture-checkout.md"}]}
```

The breakdown is parsed with the bundled TOML parser, never executed, and maps
**one heist per entry in table order**, without re-slicing:

- heist `entry-<id>`, titled by the entry; `description` is its goal and
  `verify` its acceptance and verification. Each traces to the entry's exact
  `[[entry]]` table span and to the epic lines its `covers` ids start (inside the
  epic's requirements sections, any heading containing "requirements", when it
  has one). `R1` names neither `R10` nor a sub-requirement `R1.1`.
- a bare-number `after` id names a sibling and becomes a `merged` dependency: a
  slice builds on its prerequisite's merged code. Every heist proposes
  `delivered` and `merged`.
- `hitl = true`, an `unknown`, a `spike`, `plan_checkpoint`/`done_checkpoint`,
  `refine = true`, a quoted or cross-epic `after` (`"1.3"`, `"epic-<slug>"`, a
  tracker id; a quoted number is a tracker id in BMAD, and the question says so
  when it matches a sibling) and a `covers` id no epic line starts become that
  heist's unresolved questions. GC cannot see work outside the epic, and runs no
  human step on its own. Settle them by refining the plan, then approve.
- the epic's other lines and the breakdown's comments are mapped once, as
  context, on the first entry. A requirements line no entry covers stays an
  unmapped question. A `Source conflict:` line in the epic or its architecture
  stays open on the entries whose `covers` it names, else on the whole plan.

A breakdown that does not parse or resolve is a named gap, and the preview falls
back to the conservative plan: `intake_malformed_breakdown` (invalid TOML,
`[[epic]]` initiative tables, no entries, a missing/duplicate id, title or type,
mistyped fields or NUL characters, an entry table GC cannot trace exactly, a
second `tickets.toml`, a breakdown outside the epic's folder or supplied as the
primary document), `intake_breakdown_prerequisite` (a bare `after` id naming no
entry) and `intake_breakdown_cycle`. Any of these gaps maps no heist from the
breakdown. The TOML parser loads only when a breakdown
is captured, so every other source previews from the bare package. No heist is invented from a broken
breakdown; correct the file and preview again.

## Architecture binds every heist

In a BMAD intake, a captured supporting document that is an architecture
document binds every heist of the proposal by its exact bytes. That means a v7
spine (frontmatter `type: architecture-spine` or `type: architecture`) or a
Markdown file named `architecture*.md`. The primary document is the work
itself and never binds. Spec and issue intake are unchanged. GC never links to
`_bmad-output`, because a minion's fresh worktree may not hold that directory and
the file can change after approval. Instead:

- any `architecture*.md` path a captured BMAD document names anywhere (its
  References, v6 `inputDocuments` frontmatter, Notes, a `tickets.toml` entry's
  `references`) that is not itself captured is an `intake_missing_architecture`
  gap, matched by file name, ignoring case. Supply it as a supporting document;
  an architecture supplied as the primary document is named as such.
- its lines are mapped once, on the first heist, as binding architecture.
- every approved briefing carries an `architecture` section naming the captured
  documents (snapshot id, locator, sha256) with the binding policy: build within
  them; they grant no execution authority; a conflict with the heist, its sources
  or the code is never settled silently and never by editing the architecture:
  the minion stops that part and reports both exact quotes, and Gru raises it to
  the owner as a FOR YOU decision.

## Slicing an epic with a planning minion

An epic without a breakdown can be sliced by a commissioned planning minion that
reads the codebase. `POST /api/intake/slice` with `repoPath`, `intakeId`,
`requestId` and the exact `revisionId` dispatches one tracked `investigation`
job through the normal dispatch path. It returns `jobId`, the `resultRequestId`
its plan will land at, and `dispatched` (`202`; `200` with `false` when it was
already commissioned), plus the job's `jobStatus`. It answers as soon as the
job is recorded, without waiting for a worker slot. Both ids derive from the
exact revision, so retries converge on one minion. A proposal with source gaps
or no source lines is refused (`409 intake_incomplete_sources`), as are a changed
revision (`409 intake_stale_revision`) and a revision that already has accepted
work (`409 intake_slicing_approved`, also returned to a breakdown submitted
after the revision gained accepted work). A dispatch that fails before the job is
recorded is `503 intake_slicing_dispatch_failed`; retry the identical request.
If the planning minion ends without a sliced revision (its job blocked or
closed), preview the sources again and slice the new revision. Any captured
source can be sliced; the method is written for epics.

The job's briefing binds that revision and embeds the verified GC slicing
helper (`skills/gc-build/slice.md`, with its sha256). The minion reads the
captured proposal with `GET /api/intake/<intakeId>/requests/<requestId>`, then
submits a breakdown to `POST /api/intake/slice/result` (the same binding plus
`breakdown`). The breakdown's entries name inventory requirement ids in `covers`,
never offsets, plus `after` sibling ids, `hitl`, `unknown`, `lane` and
`rationale`. Its `context` lists the framing lines and `questions` the
epic-level ones, each `Source conflict:` included. GC traces each entry to the
exact captured lines its ids name and maps entries to heists exactly as for a
v7 breakdown. It validates the result with `validatePlan` and the 2 MiB output
bound before writing anything: an entry without `covers` must say
`"clarification": true`, or its untraced acceptance is refused
`400 intake_invalid_plan`. An unknown id, a cycle, a mistyped field or an
unsupported field is refused the same way, and an oversized plan
`413 intake_output_bounds`; a corrected breakdown can still land.

An accepted breakdown becomes a refinement: request `resultRequestId` with
`previousRequestId` set to the sliced request and the same captured bytes.
The identical breakdown converges; a different one is
`409 intake_replay_conflict`. A breakdown nobody commissioned is
`409 intake_slicing_not_commissioned`. The refinement posts one FOR YOU row
(`intake.slicing-result`) listing source conflicts first, then the other open
questions. The minion never approves, admits or enqueues; review and approval
are unchanged. A changed epic is a new preview request, and its slicing is a
different minion. The earlier proposal and its sliced revision stay readable.

## Structured refinement

Without a breakdown, the default deliberately proposes one cohesive heist with unresolved goal,
scope, exclusions, acceptance and verification questions. It inventories every
nonblank source line, including metadata, without assuming it is an instruction
or satisfied requirement. Headings and BMAD boundaries do not mechanically split
heists. Missing and contradictory material remains to be clarified.

To refine, copy the returned `plan`, edit it in the existing Gru conversation
or compact browser review, and create a new revision. `POST /api/intake/revision`
requires `repoPath`, `intakeId`, a new `requestId`, `previousRequestId`, the exact
previous `revisionId` and `plan`. It retains the captured source bytes, even if
the source files changed. A new preview is a source refresh, not a plan edit.
The earlier preview/refinement POST remains supported. The public schema is
in `src/intake/types.ts`; the owned planning contract is
`resources/gc-workflows/skills/gc-build/intake.md`.

Each heist needs a safe pipeline `id`, title, goal, scope, exclusions,
acceptance, verification, milestones, dependencies, unresolved questions and
`splitMergeRationale`. A statement has `text`, `traces`, and `clarification`.
Every acceptance adds `requirementIds`; every dependency adds a target heist
`id` and one of `admitted`, `delivered`, `merged`, `done`. Proposed milestone
lists use those same GC values. Dependencies must refer to proposed heists,
which must propose the requested milestone; missing targets and cycles fail.
External dependency satisfaction cannot be presumed.

A trace has `snapshotId`, `start`, `end`, `quote`: half-open **UTF-16 offsets
into `snapshot.text`**, with an exact matching quote. A statement without
source evidence must explicitly use `clarification: true`. Mapping an acceptance
to a requirement needs a trace covering that requirement's captured span. Every
inventory requirement must be mapped or listed in `plan.unmapped` with a
`requirementId` and honest `question`. Source gaps and unmapped questions cannot
be hidden by a refinement. Invalid quotes/ids, incomplete heists, unknown
requirements/milestones, unsupported fields and model approval/status fields
return `intake_invalid_plan`. These checks validate structure and traceability,
not semantic satisfaction or approval.

## Private records and recovery

Storage is only under the **configured** data home, outside all Git checkouts:

```text
<dataDir>/projects/<sha256(canonical repo root)>/intakes/<intakeId>/
  context.json
  operational/requests/<requestId>/input.json
  operational/requests/<requestId>/capture.json
  operational/requests/<requestId>/proposal.json
  operational/requests/<requestId>/failures/<failure hash>.json
  references/
  publication-staging/
```

Directories are 0700 and payloads/receipts 0600. The operational-only binding
has no job/lane or repository-document side effects. Colliding repository
basenames are isolated by canonical-root hashes. Receipts bind exact content,
workflow and source provenance; concurrent identical publication and
receipt-before-payload recovery reuse the existing immutable artifact primitive.
Retry the original request to complete an interrupted publication. Missing
bindings, tampered bytes, unsafe storage and foreign hardlinks fail loudly as
`intake_storage_error`; restore exact original records explicitly, never replace
old bytes with a guessed revision. Readback/diff verify the input, capture and
proposal receipts/payloads; capture bytes must exactly equal the proposal's
immutable capture. A receipt without payload is a named storage error, not
not-found; exact original POST retry remains the recovery path.
Private snapshots/briefings are visible only to authenticated readers, not
public board summaries. Sources are never edited or cleaned up.

## Browser review and execution authority

Open **Review source intake** inside the existing Gru chat. Choose the managed
repository with the existing browse picker (directory selection only, not device
upload). Choose an issue (with optional explicit comment IDs), or browse/upload a
spec or BMAD Markdown document. Workspace file choices are bounded to the selected
repository; device documents use the managed upload store. The first selected
document is primary, regardless of upload completion order; subsequent documents
are explicit supporting inputs. An incomplete upload batch is refused visibly,
not silently narrowed. Retry the complete selection or explicitly **Abandon failed
document selection** before preview or new decisions. Intake's eight-document limit
is independent of ready chat attachments. Its in-flight uploads do not appear in
composer chips or block ordinary chat sends. Preview and intake decisions wait for
the complete in-flight batch.
Changing repositories clears previously selected documents. Device chooser results
remain bound to the picker/pairing that opened them, never a later chat/intake target.
Once a selection is captured, opening the ordinary chat picker does not discard
its in-flight intake batch. No links are crawled, and no BMAD installation/configuration is consulted.

**Slice into heists (planning minion)** commissions the planning minion for
the shown revision when it has no source gaps. **Load sliced revision** reads
its result request once FOR YOU says it is ready, and is a no-op until then.
This tab keeps the commission in memory; after a reload, commissioning again
returns the same minion and result request.

**Preview sources** shows repository, exact source/version/hash, goal, scope,
exclusions, acceptance, verification, dependencies and unresolved questions.
The plan JSON is editable: retain requirement IDs and exact source traces while
writing concrete statements. **Save new revision** creates immutable captured
refinement. **Compare previous revision** reads the existing immutable diff in
this disclosure before review/approval. Clearing default questions or cosmetically
changing known default case/terminal punctuation cannot make a plan executable.
Concrete clarification statements remain allowed; syntax is not semantic proof.
Known source gaps, unmapped requirements and plan/selected-heist questions disable
new approval; the server enforces them. Captured source gaps require repairing or
reselecting sources and a new preview, not deleting questions in the plan editor.
Editable plan questions/unmapped requirements require refinement and renewed review.

Click **Review this revision**, select the complete heists and their prerequisite
closure (less any prerequisite an earlier approval of this intake accepted),
then **Approve selected work**. Selection never implies approval.
**Reject revision** invalidates the reviewed token, creating no executable work.
Rejected revisions cannot reopen: use a new edited revision. Dependencies enter
as existing GC milestone gates: imported “done”, “approved”, or “merged” labels
are never completion evidence. Only GC's ledger evaluator can release work.

Review/rejection/approval POST routes are `/api/intake/review`, `/reject` and
`/approve`. Decisions contain `repoPath`, `intakeId`, `requestId`, `revisionId`
and `expectedToken` (null for an initial review). Approval additionally requires
an explicit unique `selected` array of heist IDs. Read current coordination via
`GET /api/intake/<intakeId>/review?repoPath=...`; optional `token=...` reads an
immutable historical decision. The response names `review`, `accepted` and
`remaining` heist-to-pipeline-entry mappings. Changed review state returns
`409 intake_stale_review`; changed revision bytes return `intake_stale_revision`;
changed accepted selections/entries return `intake_acceptance_conflict`.
Incomplete briefings return `intake_incomplete_plan`; missing prerequisite
selection returns `intake_dependency_selection`.

Approval freezes exact briefings/provenance and stable pipeline/job/request IDs
in the configured private ledger **before** enqueue effects. A briefing carries
the approved heist, the approval binding, the captured snapshots and, when
captured, the binding architecture section. It does not repeat the requirement
inventory, because each heist's traces hold the exact quotes it maps. Every
briefing still carries all captured sources, so one approval of 12 heists fits
when the sources total roughly 80 KiB. A prerequisite that an approval of
another revision of the same intake accepted, still in the pipeline and with
identical heist content, needs no second selection: the new entry waits on that
accepted entry. Selecting such a heist again is refused
`409 intake_already_accepted`. So an epic can be approved a few slices at a
time, each batch from a new revision, without enqueueing a slice twice. A heist
whose content changed under the same id is new work, and its dependents must
select it. A retry of the
identical approval enqueues the recorded entries, even when a newer GC renders
briefings differently. It does not create
another queue. If enqueue is interrupted, `503 intake_partial_failure` includes
accepted and remaining identities in `readback`. Read back after a timeout,
reconnect or reload; then explicitly retry the identical approval. Replays
reconcile immutable pipeline payloads and never mint replacement plans/minions.
Browser mount/reconnect/readback never approve automatically. Tab recovery stores
proposal/pending-revision identities and original explicit approval identities,
review tokens and selected heist IDs; private source/briefing content remains in
GC storage. A lost revision response is recovered by reading the original pending
request, not by creating a replacement revision. Until that pending identity is
recovered, Save/Preview cannot replace it; **Abandon pending revision** explicitly
releases only this tab's pending identity without posting replacement work.
Recovery writes validate the reader's full identity/selection limits and 2-MiB
serialized bound before effects; the tab retains at most 128 original approvals.
Unavailable durable browser storage fails intake visibly closed; chat's existing
safe storage fallback is unchanged. Automatic authentication/protocol failures and
credential re-pairing retain these identities; only explicit **Unpair this browser**
clears them. Observational recovery preserves unsaved editor text, including edits
made after an ambiguous revision submission, without storing those private bytes.

Accepted contracts never change after later previews or source edits. Previously
accepted history remains readable, including when a newer revision is reviewed.
**Read back / recover** refreshes both the current draft and saved original approval
receipts. Original approval rows name accepted/remaining entries; their explicit
retry buttons reuse the original token and selection without replacing the newer
draft. If a response was lost before its receipt arrived, the original approval
remains unconfirmed until readback or an explicit identical retry succeeds.
Receipts must match the original repository/intake/request/revision, preceding
review token and canonical selected set. A competing decision stays visibly
conflicting rather than substituting another selection or hiding the original retry.
Each failed historical receipt is reported without preventing independent healthy
receipt/draft reads. The current draft reads independently; historical receipts
render progressively with at most four concurrent receipt reads, including across
superseded recovery/pairing generations. Invalid tab recovery data produces a named actionable error
without breaking chat or sending approval. Damage to proposal receipts, decision
records or their predecessor chain fails loudly; restore exact original private bytes,
never synthesize an accepted plan. Verification is bounded to 4,096 decisions and
8 MiB of retained decision bytes per intake, checked before parsing/hashing an
over-budget history. Further appends refuse with `intake_storage_error`; use a new
intake, retaining the original history. Accepted readback verifies every immutable
pipeline field/fingerprint, including default priority/scopes; owner holds and
lifecycle transitions remain valid. A missing entry with an existing minion or durable
enqueue witness returns `intake_acceptance_conflict`: restore the pipeline ledger,
never recreate committed/occupied identities. Truly never-enqueued frozen entries
remain retryable. Additive recovery indexes retain existing decisions/events.
Execution retains GC-owned routing and private
operational artifacts; approved repository knowledge belongs only to the assigned
worktree's `gru-output/`. This feature never rewrites sources, upstream status,
old jobs, historical workflow bindings, Perkins policy or the Book of Lessons.
