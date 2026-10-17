# Onboarding heists

GC manages repositories in any language, and each one tells GC how to work in
it through its manifest, `.gru-command/worktree.toml`
([WORKTREES.md](./WORKTREES.md#1-bootstrap-manifest-18a)). A repository without
one gets lanes with no setup, a verify request answers `no_verify_command`, and
GC cannot tell which folders it may regenerate.

An **onboarding heist** fixes that. A minion reads the repository's own CI
configuration, build and dependency files and README, writes the manifest's
`[[setup]]`, `[verify]` and `reclaim`, and opens a PR titled
"Onboard &lt;repo&gt; to GC". The PR adds the manifest and changes nothing else. It
is an ordinary heist: normal review applies, and merging stays yours.

GC's code knows no ecosystem. It never looks for lockfiles or picks commands;
only the minion's briefing says how to investigate.

## Which repositories

At start, GC asks each managed repository's **origin** (never your checkout)
whether its default branch has the manifest:

- the remote names its default branch live (`git ls-remote --symref origin HEAD`);
- GC fetches exactly that branch and reads its tree.

Each probe runs off the boot path with prompts off and a 30-second deadline
(SIGTERM, then SIGKILL after a short grace), and its errors are redacted. The
fetch updates origin's remote-tracking ref for the default branch
(`refs/remotes/origin/<branch>`) and nothing else: no working tree, index,
local branch, gc or maintenance. Origin answers one of three things:

| Origin says | GC does |
|---|---|
| the manifest is there | nothing |
| the manifest is missing | proposes or dispatches (below) |
| unverified: unreachable, timed out, or no default branch named | nothing; the reason is logged and the next start checks again |

An unverified answer is never treated as missing. A cached `origin/HEAD` is a
guess, never an answer.

GC acts on a missing manifest only when all of these hold:

- no onboarding job for the repository is open;
- no onboarding card for it is waiting;
- you have not declined it.

Scans run at service start, whenever an onboarding job reaches a terminal
status (merged, done or binned), and when Gru calls the propose route.

## Modes

`[onboarding] mode` in `config.toml`
([CONFIG.md](./CONFIG.md#onboarding-proposed-autonomous-or-off)):

- **`"proposed"` (default).** Each repository gets one FOR YOU card,
  "Onboard &lt;repo&gt;". There is no Gru turn: code posts the card.
  - **Accept** dispatches the heist. If origin got a manifest in the meantime,
    nothing is dispatched and the card says why.
  - **Decline** is remembered.
- **`"autonomous"`.** GC dispatches the heist itself and posts an FYI row to
  the board's activity.
- **`"off"`.** Nothing is checked, proposed or dispatched. At start, cards from
  earlier modes are withdrawn (or, when already answered, closed with nothing
  dispatched), and so are the cards of repositories no longer in
  `managed_repos`.

Consent and autonomous mode only start a repository's **first** onboarding
heist. If one ends without the manifest reaching origin (closed, or done
without a merge), the next scan asks you with a card instead. Heists never
loop.

## Installer consent

After you choose repositories, the setup wizard checks their origins the same
way and lists the ones with no manifest. It then asks once:
"Onboard them now? [Y/n]".

**Yes** writes the one-shot file `<instance>/onboarding-consent.json`. The
file is written after the first-boot smoke, so the smoke never dispatches
anything. At the service's next start, GC:

1. records each listed managed repository's consent in the ledger,
2. removes the file,
3. dispatches each consented repository that still has no manifest and is not
   declined, with no card. The FYI row and the ledger say the consent came from
   the installer.

A few cases:

- **A card is already waiting** (the smoke boot may post one). The consent
  counts as your Accept.
- **Origin is unreachable at that start.** The consent waits in the ledger for
  a later scan.
- **Origin already has the manifest.** The consent is settled and nothing is
  dispatched.
- **Crash between the dispatch and removing the file.** This is safe. A
  repository's onboarding job id is deterministic (`onboard-<repo>`;
  `onboard2-<repo>` and so on for later heists), so a job that already exists
  counts as dispatched.

Non-interactive setup (`--no-interact`) never consents. Each missing repository
gets a card instead.

With `mode = "off"` the service does not read the consent file. It is left in
place and applied at the first start in another mode. Delete it to withdraw
the consent.

## Declines

Declining a card, or binning an onboarding job, records
`onboarding.declined` for that repository. GC never proposes it again on its
own. When you ask Gru to onboard it, Gru calls
`POST /api/onboarding/propose { "repo": "<name>" }`. That clears the decline
and scans the repository right away: a card in `proposed` mode, a heist in
`autonomous` mode, or the reason nothing is needed. The route answers with
`origin` and `action` (`proposed`, `card-open`, `dispatched`, `job-open`,
`declined`, `dispatch-failed` or `none`). With `mode = "off"` it refuses with
`onboarding_off`, and for a repository outside `managed_repos` with
`not_managed`.

## Failed dispatches

If a dispatch fails before its job exists, Gru gets an action-required row,
`onboarding.dispatch-failed`. The failed step is retried every five minutes:

- an accepted card is carried out again;
- a consented or autonomous repository is scanned again.

Only onboarding closes the row; a Gru disposition of it is refused, because
the row is what keeps the retry going. It closes when the heist is dispatched,
or when a scan finds no dispatch is needed: origin has the manifest, the
repository is declined, an onboarding job is open, a card asks the owner
instead, the repository left `managed_repos`, or onboarding is off. A later
failure posts a new row.

A dispatch that fails after its job exists leaves a blocked job, which Silas
owns like any other. Its FYI row says the job exists and is blocked, with the
error.

## Lanes take setup from their own manifest

A job lane is created at the fetched origin head, and its bootstrap applies
the manifest **in the lane**, not the one in your checkout. So a merged
onboarding PR takes effect in the next lane, even if you never pulled it. An
uncommitted manifest that exists only in your checkout runs no setup.

A writer child lane starts at its parent lane's HEAD, so it applies the
manifest committed there, including the minion's own commits. That gives the
minion no new authority: it can already run any command in its lane.

`[[link]]` and `[[copy]]` entries still resolve from your checkout. When your
checkout's manifest differs from the lane's, the lane has none, or yours cannot
be read, GC logs a `warn` that names both files.

## Proof before review

A minion wrote the manifest, so before Perkins or you review the PR, GC
proves it in a throwaway checkout. The proof runs only the manifest's own
commands; GC knows no ecosystem.

**Which heads.** A job is an onboarding job only when an
`onboarding.dispatched` event names it. Once the job has a PR, GC proves
its newest delivered head, once per head and one proof at a time across the
service. The head is read as the corrective-verification gate reads the
newest `job.delivered`: its `sha`. A delivery that is not a proven current
candidate, or whose `sha` is not a full commit id (40 or 64 lowercase hex
characters), has no head to prove: nothing is proven for it, and review
waits for the minion to deliver again. A job that has not delivered at all
has no head yet. A proof starts on a delivery or PR link, at service start,
and at the five-minute reconcile. Proofs run in every mode: `off` stops new
onboarding, never the gate on an open heist.

**What runs:**

1. `git clone --shared --no-checkout` of the managed repository into
   `<data_dir>/onboarding-probes/<job>-<sha12>`, then a detached checkout of
   the head. Both run with your git configuration, as a lane's
   `worktree add` does (hooks and fsmonitor off, no prompts), so filters
   give the content a lane gets. When the head uses Git LFS (a
   `.gitattributes` names `filter=lfs`), the checkout's `origin` is your
   repository's own `origin` (and its `lfs.url`, if set) and its LFS store
   is your repository's: smudge reads your local store first and fetches
   only missing objects from the real remote, into that same store, exactly
   as a lane does. The checkout is bounded by `[worktrees] setup_timeout_ms`.
   Your repository gains no worktree, branch, ref or index entry.
2. That head's own manifest, applied as a lane's bootstrap applies it:
   `[[link]]` and `[[copy]]` from your checkout, then each `[[setup]]`
   command, timed, under `[worktrees] setup_timeout_ms`. Unlike a lane,
   each setup command's whole process group is ended (`SIGKILL`) once its
   shell exits, so nothing setup starts (a daemon that redirects its output,
   or ignores `SIGTERM`) writes into the checkout while it is measured. A
   service stop ends a running setup command's whole process group too.
3. `verify.full`, while holding one slot of the global verification budget
   (the same FIFO and lock-wait timeout as `POST /api/verify`). GC spawns it
   itself with the budget's environment and worker share, bounded by
   `[verify] run_timeout_ms`, and ends its whole process group. The shell
   evaluates the command, so it stays its group's leader, and its pid and
   argv are bound to the slot. After a crash, the restarted scheduler keeps
   the slot while that pid lives, and onboarding's start, before it removes
   leftover checkouts, ends the group of each such verify whose pid still
   leads its group and runs the bound argv, then releases its slot. A live
   pid that is not that verify is never signalled; its slot waits for the
   scheduler's age limit. A stale release of this slot is logged at `warn`.
   The proof is not a verification of the job: no `verification.*` event is
   recorded for the `onboarding-proof` scope, no verification fence sees it,
   `POST /api/verify` refuses that scope (`400 reserved_scope`), and a
   manifest that declares it is refused by name (the proof fails on it). A
   manifest without `verify.full` passes this step as "no verify command
   declared".
4. Measuring, against a snapshot taken after the links and copies (so only
   what setup and verify made counts): the git-ignored paths that appeared,
   each sized with an `lstat` walk that never follows a link, and the
   checkout's total size without `.git`. Each `reclaim` entry is checked by
   an `lstat` of every part of its path, so a link on the way is reported,
   never walked through.

The checkout is removed whatever the outcome, and a start removes any a
crash left behind. The output tail is cut from the failing command's latest
16 KiB of output, redacted whole before it is cut: anything shaped like a
credential (private keys, GitHub, GitLab, npm, Slack, OpenAI and AWS
tokens, JWTs, URL userinfo, `Authorization` headers, `.npmrc` auth lines,
and a keyword such as `token` or `password` assigned a value of six or more
characters with a letter or digit) is masked, and a key whose BEGIN line
fell before that window is masked from the window's start. The tail is then
the last 4 KiB, starting at a whole line, so a cut never shows half a
credential and the bound holds after redaction. Failures and commands are
redacted the same way before they are recorded.

**A proof fails** when a setup command fails or times out; when verify
exits non-zero or times out; when verify exits 0 in under a second with no
output ("suspiciously empty": it may test nothing); when the manifest
cannot be used (it declares the reserved `onboarding-proof` scope, say); or
when a `reclaim` entry is or lies under a link (GC would delete outside the
lane), holds tracked files, was already there before setup ran (a
`[[link]]` or `[[copy]]` made it), did not appear, or is not git-ignored.

**A proof is deferred, never failed,** when the cause is infrastructure:
the budget wait timed out, the repository is unavailable, the clone failed,
or the service is stopping. Nothing is recorded, posted or sent; the next
reconcile proves the head again.

A proof runs once per commit, so a failure with a transient cause (network,
registry, load) stands for that head. The directive tells the minion to
push a new commit (an empty one is fine) and deliver, which gets a fresh
proof.

**What follows a proof:**

- One `onboarding.proof` event, passed or failed, on the job. The first
  proof of a head stands for that head. One reader decides what a record
  says: a record it cannot read (an unknown outcome, malformed failures) is
  never a pass. It fences review like a failure, and that head is never
  proven again.
- One PR comment per proven head, with the timings, sizes and lane size,
  starting with a hidden marker `<!-- gru:onboarding-proof job=<id> head=<sha> -->`.
  Each failure is rendered as code, so a mention, an issue reference or
  HTML in it stays inert. The output tail is never posted (the PR may be
  public): the comment says it is sent to the minion while this is the
  job's newest head, and is kept in GC's ledger. GC records the attempt
  before posting and the receipt after; after a crash it first looks for a
  comment whose body starts with the marker (a quote or a mention of it is
  someone else's comment), and never posts blind. After three failed
  attempts for a head in one run of the service, each at least one
  reconcile apart (a failed lookup counts, and a burst of triggers within
  one interval counts once), GC records `onboarding.proof-commented` with
  no comment and `cannot be posted: <reason>`, logs an error, and stops
  trying. A refusal GitHub means for good (`HTTP 403`, `404`, `410` or
  `422`, as `gh` reports it) is recorded that way at once, with no second
  attempt. An unreadable record is recorded at once as
  `cannot be posted: unreadable record`.
- On a pass, review may arm, and the Perkins packet carries an
  `ONBOARDING PROOF` block when the proof's head is the reviewed sha. Every
  command, path and failure in the block is one line (a line break becomes
  `⏎`) and cannot carry the block's end marker, so minion-written text
  cannot end the block early.
- On a failure, while that head is still the newest, the minion gets one
  directive with the failure and the output tail (the property-repair
  path). The tail sits between two delimiter lines that carry a random
  nonce, so output that prints a plain delimiter cannot end it early. A
  lane that cannot take the directive now is asked again at the next
  reconcile; a request refused before any prompt is asked again under the
  next id, up to three times.

**When a head is stuck, Gru gets one row per episode.** An action-required
row, `onboarding.proof-attention`, id
`onboarding-proof-attention:<job>:<sha12|nohead>:<delivery seq>:<reason>`,
names the delivery that opened the episode and the reason. It is posted for
the job's current head when any of these hold; the first in this order
names the row, and the detail gives every one that holds:

- `unreadable`: the head's proof record cannot be read, so the minion must
  push a new commit;
- `failures`: it is the job's third or later failed proof (the title gives
  the count);
- `unreachable`: all three directives about its failure were refused
  before any prompt;
- `retired`: the minion's turn on the directive was retired before it
  finished, and a continuation hold may need Gru;
- `unanswered`: the minion finished the directive about its failure, and at
  a later reconcile its newest delivery still names that head;
- `unadmitted`: the lane never admitted the directive (it was refused
  before any row three times, each at least one reconcile apart);
- `deferred`: its proof was deferred three times in a row in this run of
  the service, each at least one reconcile apart (the detail gives the last
  reason; a recorded proof starts the count again, and so does a restart);
- `nohead`: the newest delivery names no full commit id (or is not a
  proven current candidate), so the minion must deliver again.

There is at most one open row per job and head. Only onboarding closes a
row, and a Gru disposition of it is refused: it closes when the head's
proof passes, when a newer head is delivered, when the job ends (at once,
on the job's terminal status), when the head is proven after a deferral, or
when the head is stuck for another reason (a new row names that one). A
later episode of the same head, such as a re-delivery after its row
closed, or a second delivery that names no commit, gets a new row. A row's
id is never posted again. An ended job whose rows are closed and whose
comments are settled is not read again by the reconcile.

**The fence.** Until a passing proof exists for the newest delivered head,
the lane is busy on every path a corrective verification fences: arm,
freeze, queued handoff, fallback admission and iteration, and the Silas
review offer. The exact commit under review must pass too:

- an arm that names a target, or whose lane HEAD is not the delivered
  head, resolves that commit at once and is refused with a `409` before any
  round or review worktree exists;
- the freeze checks the exact sha it reviews last, so a commit pushed after
  the delivery (a live PR head that moved) is refused there;
- the bmad-review fallback reviews the lane's HEAD, so its admission and
  each iteration also need a passing proof of that commit.

`force` cannot waive any of it. The `409 branch_busy` blocker carries
`onboarding_proof_required_head` and `onboarding_proof_reason`
(`no-delivery`, `no-commit`, `unproven` or `failed`), and the hint says
what is missing (a proof, a delivery that names a commit, or any delivery
at all). Every `branch-idle.refused` audit records `forced` (whether force
was applied: never, for these) and `force_requested` (whether the request
asked for it). A minion's own review request is queued, not refused, and is
replayed when the `onboarding.proof` event lands, or at the next start if it
landed while the service was down. A new delivery is a new head: an earlier
head's pass no longer counts. The Silas digest still offers registering the
PR, since the proof needs it.

## Records

Onboarding writes only `onboarding.*` ledger events (no table and no migration),
its own notifications, the heists it dispatches, and the directives a
failed proof sends:

- `onboarding.proposed`
- `onboarding.declined`
- `onboarding.reopened`
- `onboarding.consented`
- `onboarding.consent-settled`
- `onboarding.dispatched`, carrying `launched_by`: `owner-accept`,
  `autonomous` or `installer-consent`
- `onboarding.dispatch-failed`, naming each failure episode's row
- `onboarding.proof`, a job event: the head, `passed` or `failed`, the
  failures, setup timings, the verify result, what appeared, each `reclaim`
  entry and the lane size
- `onboarding.proof-comment-attempt` and `onboarding.proof-commented`, the
  PR comment's attempt and receipt (posted, found by its marker, or
  `cannot be posted`)
- `onboarding.proof-attention-posted`, a job event: the head, the delivery
  seq and the reason of each attention row onboarding posted for Gru

## Not yet

- Manifests kept in GC's own folder, for repositories GC cannot open a PR on.
- Proposing re-onboarding when a repository's lanes keep failing setup.
- Anything that deletes `reclaim` folders. Today they are validated, and an
  onboarding proof checks them, nothing more.
