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
   `.gitattributes` names `filter=lfs`), the checkout gets what a lane
   shares with your repository: every `lfs.*`, `http.*`, `credential.*`,
   `url.*` (`insteadOf`), `remote.origin.*` (`url`, `lfsurl`) and
   `core.sshCommand` entry of your repository's effective config (every
   scope, with `include` and `includeIf` resolved against your
   repository's own git dir, as `git -C <repo> config --includes --list`
   reads it), less what the checkout already reads from your user and
   system config (nothing is doubled), is written into the checkout's own
   config file (never onto a command line, and no copied value is logged),
   and its LFS store is your repository's (its `lfs.storage`, a relative
   one resolved against the git common dir, else `<git common dir>/lfs`).
   Smudge reads that store
   first and fetches only missing objects, with your repository's own auth
   and routing, into that same store, exactly as a lane does. The checkout
   is bounded by the larger of `[worktrees] setup_timeout_ms` and
   `[verify] run_timeout_ms`; one that runs past it is deferred, naming the
   timeout. Your repository gains no worktree, branch, ref or index entry.
2. That head's own manifest, applied as a lane's bootstrap applies it:
   `[[link]]` and `[[copy]]` from your checkout, then each `[[setup]]`
   command, timed, under `[worktrees] setup_timeout_ms`. As in a lane, what
   a setup command starts (a dev database or a mock server it backgrounds)
   keeps running through verify, which may need it. A service stop ends a
   running setup command's whole process group.
3. `verify.full`, while holding one slot of the global verification budget
   (the same FIFO and lock-wait timeout as `POST /api/verify`). GC spawns it
   itself with the budget's environment and worker share, bounded by
   `[verify] run_timeout_ms`, and ends its whole process group. The shell
   evaluates the command, so it stays its group's leader, and its pid and
   argv are bound to the slot as the leader of its own process group. After
   a crash, the restarted scheduler, and every later stale check (each
   `acquire`), keeps the slot while any member of that group lives, its
   leader or not. Onboarding's start, before it removes leftover
   checkouts, first ends every process carrying this instance's marker or
   rooted under its probes folder (below) and waits until each is gone
   (a zombie counts as gone), then ends the group of each such verify
   whose pid still leads its group and runs the bound argv, and releases
   its slot once the group is gone. A pid `ps` cannot read is judged again
   before it counts as unjudgeable (it may have just ended). When the
   leader is gone but a member of its group lives, the group is ended as
   one once a member is confirmed the proof's (it carries this instance's
   marker or is rooted under its probes folder), and the slot is released
   after; a group none of whose members is confirmed is never signalled
   (its pgid may belong to someone else by now) and keeps the slot. A live
   pid that is not that verify is never signalled, and a pid `ps` cannot
   read is logged as an error; each such slot waits for the scheduler's
   age limit. A stale release of this slot is logged at `warn`.
   The proof is not a verification of the job: no `verification.*` event is
   recorded for the `onboarding-proof` scope, no verification fence sees it,
   `POST /api/verify` refuses that scope (`400 reserved_scope`), and a
   manifest that declares it is refused by name (the proof fails on it). A
   manifest without `verify.full` passes this step as "no verify command
   declared".
4. Ending what the proof started, before anything is measured, and
   whatever the outcome (a failed setup, a deferral, a stop): every process
   the proof starts (the clone, the checkout, each setup command and
   verify) carries the environment marker
   `GRU_ONBOARDING_PROBE=<instance>.<run>`. Every process group setup and
   verify started that is still the proof's is ended (`SIGTERM`, then
   `SIGKILL` after a grace, then a wait of up to five seconds until each
   is gone), then every process still carrying the run's marker or rooted
   in the checkout, which catches a daemon that left its group (`setsid`
   or a double fork, as the Bazel server, a Gradle daemon or watchman do).
   - A group is the proof's while one of its members was in it when its
     command's shell exited, carries the run's marker, or is rooted in the
     checkout (members are listed with `ps -o pid= -g <pgid>`, or from
     `/proc` on Linux). A group already empty when its shell exited is no
     longer tracked, and one that holds none of the proof's processes now
     is never signalled: its process group id may have been reused by
     another lane's verify or anything else.
   - The marker: Linux reads each process's environment from `/proc`;
     elsewhere GC asks `ps -axEww`. A process that scrubbed its environment
     cannot be found this way, and neither can any process on a platform
     whose `ps` hides other processes' environments (current macOS shows a
     process only its own). On Linux, a process of your user that hides
     its environment (a non-dumpable one, as `ssh-agent` and `gpg-agent`
     make themselves) cannot be read either; GC logs each such process
     once at `warn`, and only its process group or its working directory
     in the checkout can end it.
   - Rooted in the checkout: its working directory is inside the checkout,
     or its command line names a path inside it, found the way the worktree
     manager's sweep finds a lane's processes (`/proc` on Linux, `lsof` on
     macOS), off the service's event loop and bounded at 30 seconds. This
     works on every such platform and whatever the process did to its
     environment, but not for a daemon that changed its working directory
     out of the checkout and names no path inside it.
   - A listing that fails or runs past its bound is logged as an error,
     and the other listing still counts; the proof is still recorded.
   - Per-user daemons: the proof ends any daemon its setup started,
     including one that is shared per user and that a lane might reuse
     while the proof runs (a Gradle daemon, watchman, an ssh
     `ControlMaster`): a lane's build or fetch that is using it then fails.
     Lanes keep what their own setup starts; only a proof ends such a
     daemon.

   At start, GC does the same for every process carrying this instance's
   marker or rooted under its probes folder: proofs run one at a time, so
   any such process is an orphan of a crashed run.
5. Measuring, against a snapshot taken after the links and copies (so only
   what setup and verify made counts): the git-ignored paths that appeared,
   each sized with an `lstat` walk that never follows a link, and the
   checkout's total size without `.git`. Each `reclaim` entry is checked by
   an `lstat` of every part of its path, so a link on the way is reported,
   never walked through.

The checkout is removed whatever the outcome, and a start removes any a
crash left behind. The output tail is cut from the failing command's latest
16 KiB of output, redacted whole before it is cut: anything shaped like a
credential (private keys under any `PRIVATE KEY` header, PKCS#8's bare one
included, and armored PGP secret keys, `PGP PRIVATE KEY BLOCK`; GitHub,
GitLab, npm, Slack, OpenAI and AWS tokens; JWTs; URL userinfo;
`Authorization` headers; `.npmrc` auth lines; and a keyword such as
`token`, `password`, `aws_secret_access_key`, `private_key` or
`client-key-data`, with `_`, `-` or nothing between its words, so camelCase
too (`secretKey`, `clientSecret`), or a key that ends an identifier in
`password`, `token`, `secret` or `secretaccesskey` whatever starts it
(`PGPASSWORD`, `dbPassword`, `githubToken`, AWS STS's `SecretAccessKey`
and `SessionToken`; `AccessKeyId` is no secret and stays), quoted as JSON
quotes it or not, assigned a value of six or more characters with a letter
or digit) is masked, and a key whose BEGIN line fell before that window is
masked from the window's start. The tail is then the last 4 KiB, starting
at a whole line, so a cut never shows half a credential and the bound holds
after redaction. When one line is longer than the tail (or a stream's kept
output starts inside one, as a setup stream whose earlier output was
dropped does), its last bytes are kept from the first whitespace after the
cut, after a first line `(output tail starts mid-line)`, so a token the
cut split never shows its back half; with no whitespace to start at, the
tail records only `(last line longer than <N> KiB, not shown)`. A command
that printed something never records an empty tail. Failures and commands
are redacted the same way before they are recorded.

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
  starting with a hidden marker
  `<!-- gru:onboarding-proof job=<id> head=<sha> nonce=<nonce> -->`. Each
  failure is rendered as code, so a mention, an issue reference or HTML in
  it stays inert. The output tail is never posted (the PR may be public):
  the comment says it is sent to the minion while this is the job's newest
  head, and is kept in GC's ledger. GC records the attempt, with a fresh
  random nonce, before posting and the receipt after. After an interrupted
  post it first looks for a comment whose body starts with the marker of a
  recorded attempt for that head, nonce included, and never posts blind.
  Job and head are public but no one sees a nonce until GC posts it, so a
  comment with GC's job and head and no or another nonce, a quote of the
  marker, or a mention of it is someone else's (no author is asked). An
  attempt recorded before markers carried a nonce (by an older build) is
  looked up by that build's marker,
  `<!-- gru:onboarding-proof job=<id> head=<sha> -->` at the start of a
  comment, so an upgrade in the middle of an interrupted post never posts
  twice. After three failed attempts for a head in one run of
  the service, counted at most once per reconcile (a failed lookup counts,
  and any burst of triggers between two reconciles counts once, whatever
  the clock says), GC records `onboarding.proof-commented` with no comment
  and `cannot be posted: <reason>`, logs an error, and stops trying. A
  refusal GitHub means for good (`HTTP 403`, `404`, `410` or `422`, as `gh`
  reports it) is recorded that way at once, with no second attempt.
  Throttling never is, whatever its status: a rate limit (GitHub's
  secondary limit on comments answers 403), the abuse detection mechanism
  (403) or content `submitted too quickly` (422) is retried at every
  reconcile and never counts as a failed attempt. An unreadable
  record is recorded at once as `cannot be posted: unreadable record`.
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
  before any row in three different reconciles; once the lane admits a
  directive, the refusals before it count no more);
- `deferred`: its proof was deferred three times in a row in this run of
  the service, counted at most once per reconcile (the detail gives the
  last reason; a recorded proof starts the count again, and so does a
  restart, which never closes the row);
- `nohead`: the newest delivery names no full commit id (or is not a
  proven current candidate), so the minion must deliver again.

There is at most one open row per job and head. Only onboarding closes a
row, and a Gru disposition of it is refused: it closes when the head's
proof passes, when a newer head is delivered, when the job ends (at once,
on the job's terminal status), when the head is proven after a deferral,
when the head is stuck for another reason (a new row names that one), or
when no reason holds and its own is known to have cleared: an `unadmitted`
row once the lane admitted the directive (live or settled), an
`unanswered` one on a newer delivery or a new directive turn on the job.
The counts behind `deferred`, `unadmitted` and `unanswered` live in the
service's memory, so a restart empties them: a restart alone never closes
a row (a deferral row closes only on a proof of its head), and the reason
holding again keeps the same open row, never a `:2`. A later episode of the same head, such as a re-delivery
after its row closed, or a second delivery that names no commit, gets a
new row, and so does a reason that holds again after its row closed (its
id ends `:2`, `:3`, and so on). A row's id is never posted again. An ended
job whose rows are closed and whose comments are settled is not read again
by the reconcile.

**The fence.** Until a passing proof exists for the newest delivered head,
the lane is busy on every path a corrective verification fences: arm,
freeze, queued handoff, fallback admission and iteration, and the Silas
review offer. The exact commit under review must pass too:

- an arm that names a target resolves that commit at once and is refused
  with a `409` before any round or review worktree exists. An arm with no
  target reviews the live PR head, not the lane's HEAD, so a commit the
  minion left unpushed in its lane does not refuse it;
- the freeze checks the exact sha it reviews last, so a commit pushed after
  the delivery (a live PR head that moved) is refused there;
- the bmad-review fallback reviews the lane's working tree, uncommitted
  changes included, so its admission and each iteration need a passing
  proof of the lane's HEAD and a clean lane: tracked changes, or untracked
  files git does not ignore (`git status --porcelain`), are uncommitted
  changes the proof never ran, and refuse it. What the lane's bootstrap
  placed is not uncommitted: the manifest's `[[link]]` `at` and `[[copy]]`
  `to` paths are left out (a `node_modules` link that a `node_modules/`
  ignore rule misses, since a link is no folder). A gate whose fix leaves
  an unproven lane HEAD, a new unproven delivery or uncommitted changes
  stops before its next round and aborts with `code:
  "onboarding-proof-required"` and a hint: the minion commits the fix,
  pushes it to the PR branch and delivers; GC proves the new head itself,
  and review re-arms once that proof passes (the Silas digest offers the
  review again, and a queued self-review request is replayed).

`force` cannot waive any of it. The `409 branch_busy` blocker carries
`onboarding_proof_required_head` and `onboarding_proof_reason`
(`no-delivery`, `no-commit`, `unproven`, `failed`, or `uncommitted` for the
fallback's lane check), and the hint says what is missing (a proof, a
delivery that names a commit, any delivery at all, or a lane with nothing
uncommitted). Every `branch-idle.refused` audit records `forced` (whether force
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
  PR comment's attempt (with its marker's nonce) and receipt (posted, found
  by its marker, or `cannot be posted`)
- `onboarding.proof-attention-posted`, a job event: the head, the delivery
  seq and the reason of each attention row onboarding posted for Gru

## Not yet

- Manifests kept in GC's own folder, for repositories GC cannot open a PR on.
- Proposing re-onboarding when a repository's lanes keep failing setup.
- Anything that deletes `reclaim` folders. Today they are validated, and an
  onboarding proof checks them, nothing more.
