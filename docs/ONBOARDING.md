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

## Records

Onboarding writes only `onboarding.*` ledger events (no table and no migration),
its own notifications, and the heists it dispatches:

- `onboarding.proposed`
- `onboarding.declined`
- `onboarding.reopened`
- `onboarding.consented`
- `onboarding.consent-settled`
- `onboarding.dispatched`, carrying `launched_by`: `owner-accept`,
  `autonomous` or `installer-consent`
- `onboarding.dispatch-failed`, naming each failure episode's row

## Not yet

- Proving the manifest in a throwaway lane before review: setup, `verify.full`,
  and measured `reclaim`.
- Manifests kept in GC's own folder, for repositories GC cannot open a PR on.
- Proposing re-onboarding when a repository's lanes keep failing setup.
- Anything that uses `reclaim`. Today it is validated and recorded, nothing more.
