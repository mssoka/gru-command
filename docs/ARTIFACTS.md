# GC workflow artifact ownership

Issue [#293](https://github.com/mssoka/gru-command/issues/293) provides explicit
storage primitives in `src/artifacts/context.ts`. They separate private job
material from portable, approved project knowledge. They do **not** change
existing BMAD session bindings, provision projects, import issues, authorize
execution, or migrate anything. Runtime integration is owned by #294; the
existing managed BMAD runtime continues using its historical layout until
that integration lands.

## Locations and authority

| Material | Location | Contents |
| --- | --- | --- |
| Job binding | `<data_dir>/projects/<project-key>/jobs/<job-id>/context.json` | Registered repository, job, assigned worktree and selected workflow identity |
| Operational artifacts | `<job-directory>/operational/<relative-path>` | Explicitly supplied plans, drafts, rendered instructions, import snapshots |
| Artifact references | `<job-directory>/references/<reference-key>.json` | Logical output location, exact SHA-256, workflow/source identities, document approval receipt; **not** document content |
| Publication staging proofs | `<job-directory>/publication-staging/<uuid>.json` | Private temporary ownership records for exclusive staging inodes; never approved-document bytes |
| Project knowledge | `<assigned-worktree>/gru-output/<relative-path>` | Explicitly approved specs, architecture/decision documents and relevant knowledge |

`data_dir` comes from GC configuration (default `~/.gru-command`). The helper
requires the caller to pass the configured absolute path; it never guesses
HOME, an installation path, or a BMAD output directory. This root must be
outside all Git checkouts, including the registered repository and assigned
worktree; private job material must not appear in another project's checkout.

The full SHA-256 of the **canonical registered repository path** is the
project key. Repository names and temporary worktree basenames are not
identities. Two repositories named `app` have separate namespaces, as do two
jobs of one repository. The caller supplies the actual registered job lane
from the existing worktree registry. The helper verifies job ownership, a
live lane, the exact Git checkout root, and a linked worktree belonging to
that registered repository. Main-checkout and foreign-repository writes are
refused. A registered repository relocation is a new identity; this API does
not discover/move historical namespaces.

The caller also supplies the verified selected workflow ID and full content
SHA-256. The helper records these; it does not verify/load workflow resources
or pick a replacement workflow.

## Caller example

```ts
const artifacts = createArtifactContext({
  dataDir: config.dataDir,
  worktree: registeredJobLane,
  workflow: { id: selectedWorkflow.id, sha256: selectedWorkflow.contentSha256 },
});
const sources = [{
  kind: 'github-issue',
  locator: 'https://github.com/example/project/issues/1',
  revision: capturedRevision,
  sha256: capturedContentSha256,
}];
const draft = artifacts.writeOperational({
  path: 'proposals/revision-1.md', contents: proposalText, sources,
});
// Only AFTER approval at the existing owner authority boundary:
const spec = artifacts.publishDocument({
  path: 'specs/feature.md', contents: approvedText, sources,
  approvalId: ownerApprovalReceiptId,
});
const verified = artifacts.readReference(spec.scope, spec.path);
```

Source locators and hashes describe exact captured inputs; they are untrusted
metadata, never executable instructions. `sources: []` explicitly means no
external source snapshot. Supply a new snapshot/reference for a new revision,
not a silent rewrite of accepted work.

`publishDocument` requires a nonempty approval receipt identity. It does not
create approvals or validate owner permissions: the authorized caller must
perform that check first. Only the text explicitly provided to this method is
published. It never scans/copies operational directories, captures, sessions,
service configuration, credentials or workflow-package files. Do not include
secrets or raw private evidence in approved text. Metadata receipts remain
private, including source locators; handoff/export authorization belongs to
the caller.

The approved document's **one authoritative mutable copy** is the ordinary
worktree file. Its private receipt is immutable metadata, not a competing
editable contract. `gru-output/` is neither auto-ignored nor auto-committed;
publication refuses a Git-ignored document path (including global/system
excludes and configuration carriers) and never edits ignore rules.
Review/version its documents normally. They remain readable without GC or
BMAD. Editing a document changes its hash, so the old reference subsequently
refuses verification; a new approved revision needs a new publication path.

## Initialization, resume and refusal

- New private namespaces/directories are `0700`; private payloads, bindings and
  receipts are `0600`. Existing configured data-home permissions are not
  changed; newly created namespaces provide privacy beneath it. Existing
  permissive private namespaces/files are refused, never silently chmodded.
- New knowledge directories/files use `0755`/`0644` subject to the process
  umask. Existing knowledge and its permissions are preserved. Repeated
  initialization does not enumerate, rewrite or delete documents.
- Job/worktree/workflow binding is immutable. Resuming the same registered job
  resolves its old namespace and checks the same binding. A changed workflow,
  assigned worktree or corrupt/missing binding in an existing nonempty
  namespace fails with `ArtifactContextError`; restore recorded material
  explicitly instead of silently adopting today's workflow. The registry
  snapshot establishes admission; the caller must obtain a current snapshot
  for a new lifecycle. Every operation re-verifies the actual linked checkout;
  a normal manager sweep removes it before recording `swept` and thus refuses
  further operations even through an existing context.
- Publication is exclusive and atomic for each file. Exact provenance is
  published **before** payload bytes. Identical retries are idempotent;
  different bytes or provenance refuse without replacing the winner. New
  revisions use new relative paths. A crash leaving a receipt without content
  is finished by an identical retry; orphaned content without a receipt is
  refused rather than assigned guessed provenance. A missing receipt/content
  is never treated as a verified reference. A concurrent/crashed publisher's
  fully-written internal staging hardlink requires an exclusive **private
  ownership record** matching its UUID, target, inode and hash; names alone
  never establish ownership. An identical publication finishes only those
  authenticated links/proofs; foreign hardlinks remain unchanged and refuse.
  This narrow staging cleanup
  is not a retention sweep.
- Absolute output paths, traversal, empty components, backslashes, colon
  paths, control characters, wrong-kind entries, symlinks (including dangling
  links and ancestor components), and foreign file hardlinks are refused.
  Filesystem-equivalent case/Unicode spellings are rejected using the exact
  stored directory entry, so one document cannot acquire competing approvals.
  Use normalized absolute roots without symlink components; on systems with
  `/tmp` or `/var` aliases, supply their canonical paths. Boundaries are
  checked again on every operation, including whether the data home became
  part of a Git checkout after binding. Files are opened without following leaf
  symlinks and read through a checked descriptor. Do not permit an untrusted
  process to rename/replace trusted ancestor directories during operations;
  this API is not a filesystem sandbox against a concurrent hostile owner.
- Reference resolution checks namespace, workflow, source metadata, approval
  and payload hash. Missing/corrupt records do not fall back to ambient state.

There is no directory-copy export, recursive cleanup, retention policy,
historical rewrite or production database mutation. Existing `_bmad-output`,
`_bmad`, unrelated skills, capture/session/review stores and ledger references
remain untouched and readable. Any legacy transfer is a separate explicit
owner-run operation, not an initialization side effect.

## Verification

`test/artifact-context.test.ts` uses disposable registered Git repositories,
assigned linked worktrees and isolated custom data homes. Run:

```sh
npm run test:backend -- test/artifact-context.test.ts
npm run typecheck
npm run lint
npm run build
npm test
```

No service launch, real provider/model call, owner-repository cleanup or
production ledger change is required. These storage checks and independent
development reviews do not replace exact-final-head native Perkins release
gates or claim native READY. The owner retains merge and rollout authority.
