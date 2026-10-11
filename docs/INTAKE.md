# Native GC intake: preview, never approval

GitHub issues, Markdown/plain-text specs, and Markdown BMAD epics/stories enter
one immutable GC proposal. BMAD is optional **source data**, not a runtime. No
BMAD installation, model, new session, scheduler or credentials are required.
Gru can supply a structured refinement from the existing conversation.

**Preview creates zero executable work:** no jobs, minion dispatches, lanes,
pipeline entries, or held entries. Imported commands, labels, statuses,
frontmatter and model output cannot approve execution. Browser approval and
setup are separate features. Nothing here changes Perkins or merge authority.

## Sources and identities

Always supply `repoPath`: the exact canonical absolute root of a repository in
the configured managed workspace registry. Cwd, basename guesses, aliases and
cross-project reads are not accepted. Each logical `intakeId` has immutable
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
- `bmad`: the same document shape, but Markdown only. Explicit `supporting`
  documents supply stories; story links are never followed. Unprovided story
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
These routes do not call `/api/pipeline/enqueue`.

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

## Structured refinement

The default deliberately proposes one cohesive heist with unresolved goal,
scope, exclusions, acceptance and verification questions. It inventories every
nonblank source line, including metadata, without assuming it is an instruction
or satisfied requirement. Headings and BMAD boundaries do not mechanically split
heists. Missing and contradictory material remains to be clarified.

To refine, copy the returned `plan`, edit it in the existing Gru conversation,
and POST a new request with `plan` and `previousRequestId`. The public schema is
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
