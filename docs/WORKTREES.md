# The worktree manager

SPEC ruling 18's five subsystems — the dispatch flow's worktree engine,
landed as its own review lane (Perkins r4 split). The E8 core rides it
through the worktree **port** (`src/dispatch/worktree-port.ts`); this
lane provides the implementation and owns the release/answer endpoints.

## 1. Bootstrap manifest (18a)

Each project repo declares its fresh-worktree needs in-repo at
`<repo>/.gru-command/worktree.toml`; applied automatically at creation:

```toml
reclaim = ["build"]      # top-level, before any table: folders setup or builds
                         #   create and git ignores, which GC may regenerate

[[link]]                 # symlink created in the fresh worktree
at = "fixtures/large"    #   worktree-relative (no ..)
to = "fixtures/large"    #   target: repo-root-relative (.. allowed) or absolute

[[copy]]                 # file copied from the source checkout
from = ".env.local"      #   repo-root-relative (no ..)
to = ".env.local"        #   worktree-relative (no ..)

[[setup]]                # one-time command, cwd = the worktree
command = "npm install"

[verify]                 # verification commands by scope (POST /api/verify;
full = "npm test"        #   see FLOW.md §4c — default scope `full`)
quick = "npm run lint"
```

Scope names are lowercase identifiers; `onboarding-proof` is reserved for
GC's onboarding proof ([ONBOARDING.md](./ONBOARDING.md#proof-before-review)),
and a manifest that declares it is refused by name.

A missing manifest is a no-op; a malformed one fails loud and rolls the
worktree back **all the way** (worktree AND the branch the failed call
created — a leftover `gru/<job>` would wedge the job id forever).

**Which manifest applies (#427).** Bootstrap applies the manifest committed
in the **lane** itself. A job lane is created at the fetched origin head, so a
manifest merged on origin takes effect in the next lane even when the source
checkout has not pulled it. An uncommitted manifest that exists only in the
source checkout runs no setup. A writer child lane starts at its parent lane's
HEAD, so it applies the manifest committed there, including the minion's own
commits. That is no new authority: the minion can already run any command in
its lane with its shell. `[[link]]` and `[[copy]]` entries still resolve from
the source checkout. When the source checkout's manifest differs from the
lane's, or the lane has none, or it cannot be read, the manager logs a `warn`
naming both files.

**`reclaim` (#427)** lists repo-relative folders that setup or builds create
and that git ignores, so GC may delete and recreate them. Each entry is
normalized (`./build/` → `build`). An entry fails loud, naming it, when it is
empty or `.`, absolute, contains `..` or NUL, has a `.git` or `.gru-command`
segment (it is, or sits inside, one), or repeats an earlier entry.
Onboarding heists write it, and an onboarding proof fails a manifest whose
entry does not appear, is not git-ignored, or holds tracked files
([ONBOARDING.md](./ONBOARDING.md#proof-before-review)). Lane slimming
deletes these folders from an idle lane and `[[setup]]` brings them back
([§6](#6-lane-slimming-427)).

GC-owned workflows need no BMAD manifest entry or project/global installation.
New lanes bind the owned workflow and explicit artifact context when the minion
spawns; approved portable knowledge lives in `gru-output/`. Independent user BMAD
and explicit project setup commands remain user-owned and are honored unchanged.

GC-marked `GRU COMMAND BMAD BOOTSTRAP` blocks are retired: new bootstrap refuses
them before executing any links, copies or commands. Use the precise, owner-run
preview/backup/retirement procedure in [BMAD-RUNTIME.md](./BMAD-RUNTIME.md); edited
or uncertain blocks require deliberate repair, never automatic cleanup. Existing
jobs still resolve verification commands from their original manifests and keep
their original runtime bindings and paths.

## 2. Registry (18b)

The ledger is the authoritative map job → worktree → branch → **processes**:
the `worktrees` and `worktree_processes` tables. Sweeps match registry
paths ONLY — never id-proximity, never labels. Every pid a pause or a
confirmed kill is grounded on lands in the registry, so the ask always
names exactly what was live.

The orchestrator's OWN spawned services land there too: the verification
scheduler records every run it spawns for a lane (pid + argv, evidence
`registry`) and reconciles it on exit. A service the orchestrator started
for a lane is the lane's to tear down — not a stranger's.

## 3. Preserve-first ordered sweep (18c)

`release()` order is law:

0. **Refuse early** (#427). The structural checks run before an untracked
   file is copied or a process is reaped, paused on or killed, and again
   just before the removal (the tree may change while a release waits or
   kills). The snapshot is not built here: what a process still writing in
   the lane does to a build is a race, never a reason to refuse, and it is
   step 4's pause that names the process, so `confirm_kill` can reach it;
   step 5 builds and proves the snapshot once the processes are handled.
   Each refusal retains the tree, names what it found and says what clears
   it:
   - **Mid-operation.** A merge, rebase, cherry-pick, revert or bisect in
     progress, or a multi-commit cherry-pick or revert with commits still
     to go (`git rev-parse --git-path` finds `MERGE_HEAD`, `rebase-merge`,
     `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` or
     `sequencer/todo`), or unmerged index entries. The refusal names the
     command (`git merge --abort`, `git rebase --abort`,
     `git bisect reset`, `git cherry-pick --continue`, `git reset --merge`, …).
   - **A sparse checkout** (`core.sparseCheckout` on, cone mode or not).
     Entries outside the cone are absent from disk and marked skip-worktree,
     so GC cannot tell them from files a minion deleted, and a snapshot
     could record the wrong tree. The refusal says to commit and push the
     lane's work, or run `git sparse-checkout disable` in the lane, and Gru
     gets one **action-required** row for the lane (kind
     `worktree.sparse-checkout`, closed once the lane is gone, as below).
     Lanes are never sparse by GC's doing: `git worktree add` gives a new
     lane the owner checkout's sparse-checkout, so GC runs
     `git sparse-checkout disable` in each new lane (off the event loop: it
     checks the whole tree out), before anything runs in it, when the
     repository keeps per-worktree config
     (`extensions.worktreeConfig`, which `git sparse-checkout` itself turns
     on): only the lane changes, and the owner's checkout stays as sparse as
     it was. A repository whose sparse checkout is in its shared config
     (`core.sparseCheckout` set in `.git/config` by hand, with no
     per-worktree config) gives every lane one, and GC leaves it, with a
     warn: disabling it there would change the owner's repository config.
     Such a lane, or one a minion or a setup made sparse, is refused as
     above.
   - **Work in a nested repository that would be lost.** A nested
     repository is every git repository inside the lane other than the lane
     itself: its submodules at any depth, and any repository its index or
     HEAD records as a gitlink (an embedded repository committed or staged
     with no `.gitmodules`). Each keeps its git data under the lane's own
     git folder or in a `.git` inside its checkout, which the removal
     deletes, and the snapshot records only its gitlink. GC finds them in
     the lane with one bounded `git ls-files -s` (mode `160000`), a staged
     diff for gitlinks HEAD records and the index no longer does, and the
     `.gitmodules` at the lane's base, HEAD and working tree, whether or not
     a `.gitmodules` exists; then the same inside each nested repository
     with a checkout. Detection ignores every display setting (`-c
     diff.ignoreSubmodules=none`, `--ignore-submodules=none`), so neither
     user, repository nor global config hides anything. Three more places
     hold nested repositories that no listing above names:
     - **The lane's own `modules` folder** (`git rev-parse --git-path
       modules`, under `.git/worktrees/<id>`): every submodule repository
       the lane ever initialized, whether or not any path names it now (a
       submodule added and then reset away leaves a folder holding only its
       gitfile). Each git folder there not met above is judged by itself
       (`git --git-dir <dir> rev-list … --not …`), with its own `git status`
       when its `core.worktree` names a checkout in the lane whose `.git`
       leads back to it.
     - **Ignored folders.** `git ls-files --others --ignored
       --exclude-standard --directory` lists them without descending into
       one; each that is a repository (it holds a `.git` git reads as one)
       or holds one at most three levels below it is judged as above. The
       walk never follows a link and never looks into a folder named
       `node_modules`. **Limits:** a repository deeper than three levels
       below an ignored folder, or inside a `node_modules`, is not found,
       and the release deletes it with the lane.
     - **Submodule folders never initialized.** A gitlink folder (index or
       HEAD) holding files but no `.git`: git lists none of them, so step 1
       copies the folder whole (unless the submodule's `.gitmodules` at the
       base says `ignore = untracked` or `all`).

     (An untracked folder holding a `.git` is no gitlink: step 1 copies it
     whole, its `.git` and commits with it.) A release refuses (never
     deletes) a nested repository whose commits would not survive. The
     nested-repo scan covers submodules (initialized or only in the admin
     folder), embedded and ignored repositories within the depth bound, and
     uninitialized submodule folders; what lies beyond the bound is a
     documented limit. A nested repository is safe to remove with the lane
     only when both hold:
     - **its index and working tree are clean** (its own `git status`,
       untracked files included): modified or staged tracked content is
       refused by its path, whatever `.gitmodules` `ignore =` says
       (`ignore = dirty` quiets `git status`; it does not make the content
       disposable). Untracked content is no loss: step 1 copies it into the
       preserve folder under its path in the lane, at any depth. The
       exception is a submodule whose `.gitmodules` at the lane's base sets
       `ignore = untracked` or `ignore = all`: the user declared its
       untracked files disposable (build leftovers), so they are neither
       copied nor refused. A change inside a repository nested in it is
       judged in that repository, never in the one around it.
     - **every commit it can reach survives**: each commit reachable from
       its HEAD, its branches, its tags, its stash and the reflogs of HEAD,
       the branches and the stash (`git rev-list` over them `--not
       --remotes`, bounded) is the gitlink the lane's **base** (the registry
       row's `sha`) records for it or an ancestor of that, or is in one of
       its remote-tracking refs, or is in the main checkout's own copy of it
       (`<git common dir>/modules/<name>`, which outlives the lane). A tag in
       the lane's own copy is no evidence: it goes with the lane, so an
       unpushed commit `npm version` tagged is refused. A commit only the
       reflog holds (a detached-HEAD commit a later `git submodule update`
       put back at the pin) is refused, and so is a gitlink bump to an
       unpushed commit with a clean status. A lane that touched nothing is
       released even when its base's pin is reachable only from a tag or was
       fetched by its sha into a shallow copy.

     A staged `git rm` of a submodule, an update to commits its remote has
     (`git submodule update --remote`) and a pushed commit are not refused.
     The refusal names each nested repository by its path and what it holds
     (the first commits at risk, each with where it was found: its HEAD, a
     branch, a tag, a stash entry, its reflog; "push the submodule
     commit"), and carries a **digest** of that work: each repository's
     path, states and HEAD, the commits at risk, and a hash of its tracked
     content (`git diff --binary HEAD` inside it). Untracked files are not
     in the digest: step 1 keeps them, no discard covers them, and a
     watcher writing caches does not move it. The refusal is recorded once
     per lane and digest (for a lane with no job too) as
     `worktree.submodule-work-refused { id, path, digest, submodules }`, and
     Gru is told at every refusal, one **action-required** row per lane and
     digest (kind `worktree.submodule-work`, the row id keeps it to one, so
     a notice that failed once is posted by the next refusal) naming the
     repositories, their commits or states, what to do (tell the minion to
     push the submodule commit, or ask the owner to discard with the digest)
     and the digest. A refusal with a newer digest closes the older row.
     Every row about a lane (submodule work, a sparse checkout, a restore
     that came back incomplete) closes when the lane is swept by any path (a
     release, the reconcile of a lane whose tree is gone, a removal GC
     finished), and the slimmer's five-minute reconcile closes any whose
     lane is swept or out of the registry, or whose job ended with its tree
     gone (producer-resolved: a disposition cannot close them). Only an
     **operator** release may discard the work, by passing
     `discard_submodule_work: "<digest>"`: the discard covers exactly the
     work that refusal showed, and when the lane's nested work changed since
     (a new commit, more edits, another repository), the release refuses
     again with the new digest, and the error and the new row say so: if it
     keeps changing, something is still writing into the submodule, so stop
     that process first, then discard the newest digest. A discard without a
     digest is refused. The discard is recorded first as
     `worktree.submodule-work-discarded { id, path, digest, submodules:
     [{ path, state, head }] }`. The autopilot and a Silas release never pass
     it.

   A refusal that comes after step 1 removes the copy step 1 made, so a
   refused release never leaves a new folder under the preserve root.
1. **Preserve** untracked deliverables FIRST (`--porcelain -z` — never
   C-quoted paths; `--untracked-files=all`, so a repository whose
   `status.showUntrackedFiles` hides untracked files still has every one
   copied; an untracked folder holding a `.git` is copied whole, its `.git`
   with it; the untracked content of nested repositories too, at any depth
   (step 0); symlinks are
   preserved AS LINKS; a FIFO, socket or device (one met inside a copied
   folder too) is skipped with a warn naming it and never opened, since
   opening a FIFO waits for a writer; the copy runs off the event loop; a
   genuine mid-sweep vanish is skipped+logged; any
   other preserve failure ABORTS the sweep with the tree intact and the
   partial copy withdrawn — deliverables are never sacrificed). The copy is
   recorded (`worktree.preserved`) when the release pauses or reaches the
   removal; a copy on the record is kept even if the release is refused
   after it.
2. **Reap tracked services** — live `registry`-evidence processes are
   signalled (process group SIGTERM → grace → SIGKILL) and recorded
   killed, with a `worktree.service-reaped` event. Dual-keyed: a pid is
   signalled only when its registry row is live AND it still enumerates
   as rooted in the tree (a recycled pid can never redirect the kill).
3. **Enumerate** processes rooted in the tree: argv **path-boundary**
   match (a sibling lane `job-a-2` is never confused with `job-a`) OR
   the process's actual **cwd** (lsof on macOS, procfs on Linux; other
   platforms argv-only, declared).
4. **Pause and ask** — any other live process pauses the sweep (needs-owner
   escalation — a destructive step is the owner's ruling) and touches
   nothing. `confirm_kill` answers the RECORDED ask: it kills exactly
   the acknowledged pids (never a fresh enumeration — later arrivals
   were never acknowledged), with a SIGTERM grace before SIGKILL.
   Survivors re-pause; newcomers get their own ask; `confirm_kill`
   without a recorded pause is not honored. Silent kills do not exist
   for processes the orchestrator did not spawn.
5. **Snapshot** the uncommitted tracked work (#427), then **remove** the
   worktree. `worktree remove --force` keeps nothing tracked, so every
   release (operator, autopilot, child, review, failed-dispatch cleanup)
   saves the lane's tracked edits and deletions first, without writing the
   lane's own index (a stale `index.lock` left by a killed `git commit`, or
   an intent-to-add entry, cannot block it). Untracked files are not in it:
   step 1's preserve copy keeps them, so nothing is stored twice, a nested
   repository never blocks a release, and an untracked secret never lands
   in a commit.
   - The lane's index file is copied to a temporary one (a plain read: no
     `index.lock`, and its stat cache comes along, so an unchanged file is
     not hashed again), with the index file's own times: git hashes again
     any entry written in the index's last second ("racily clean"), as the
     real index would have it, so a file rewritten at the same size in that
     second is saved as rewritten. The copy goes to the system's temporary
     folder, else (that folder full or unwritable) to the preserve root. A
     readable index that cannot be copied to either refuses the release by
     name, saying how many files it stages new: a snapshot from HEAD would
     lose them. Only when the lane's index cannot be read at all (it is
     missing or unreadable) is the temporary index read from HEAD instead
     (`git read-tree HEAD`), with one warn saying that which files it staged
     new cannot be known and none is in the snapshot (with no index, git
     counts every file in the lane untracked, so the preserve copy holds
     them all). The temporary index is removed afterwards.
   - On the temporary index, the assume-unchanged and skip-worktree bits
     are cleared for every entry whose file is on disk (`git ls-files -v`
     shows them), so an edit behind either is saved. An entry absent from
     disk keeps its bits. Those bits are also how a local file is kept out
     of `git status` on purpose (a tracked `config/database.yml` or
     `.env.development` with local values, possibly credentials), so such a
     file is saved too, into the local `refs/gru/preserved/*` commit. These
     refs stay in the user's own repository: GC never pushes them (a
     `git push --mirror` of your own would).
   - `GIT_INDEX_FILE=<tmp> git add -u` adds every tracked edit and
     deletion, and `git write-tree` writes the tree. If either fails (a
     tracked file git cannot read, say), the release is refused by name,
     naming the file when git does; it never falls back to HEAD.
   - The tree is proven with the same index: `git diff --quiet <tree> --`
     (submodules aside: their work was refused or discarded in step 0)
     shows the tracked working tree equals it. A tree that does not match
     (something still writing, or a filter whose output changes) is refused,
     with the tree retained.
   - When the tree is HEAD's, nothing is written. Otherwise the records the
     removal depends on are written first (`worktree.preserved`, an
     operator's submodule discard), then `git commit-tree <tree> -p HEAD`
     makes one commit, authored by GC (`Gru Command
     <gru-command@localhost>`, so a host with no git identity can make
     one), and `git update-ref refs/gru/preserved/<lane>/<UTC stamp>
     <commit>` names it, just before the removal: a release refused on the
     way leaves no ref behind. The ref is never a branch or a tag and needs
     no reflog. GC never deletes these refs (expiry is a later change).
   - If anything after those records fails (the ref cannot be written, or
     `worktree remove` fails, on a busy mount say), the tree is retained and
     GC records `worktree.release-aborted { id, path, preserved: {
     destination, files }, snapshot: { ref, sha, files }, discarded, error }`,
     naming the preserve folder and any ref already written. A retry reuses
     that preserve copy while the lane's untracked files are unchanged (the
     same paths, links and bytes), that ref while it names a commit of the
     same tree on the same HEAD, and that discard record: it makes no new
     folder, ref or record, and a retry that fails the same way adds no
     second `worktree.release-aborted`.
   - A `worktree remove` that fails part way (a read-only folder, a busy
     mount) has already deleted the lane's git folder (`.git/worktrees/<id>`)
     and part of its tree: git deletes that folder whatever happened to the
     tree, and no git command runs in what is left. GC checks the
     repository's worktree records; when none names the lane any more, it
     deletes what is left of the tree (read-only folders made writable
     first, a link removed as a link), runs `git worktree prune`, and the
     release completes as usual (the lane swept, the owner told what was
     saved), with `worktree.sweep-tail-failed { id, stage: "remove", error }`
     naming what happened. When the rest cannot be deleted either, the
     release is refused by name with what is left in place. A release of a
     lane found in that state (the git folder gone, part of the tree left)
     takes the same path and then reconciles the lane as removed; unless an
     aborted release of GC's saved the lane's work before its removal began,
     it first copies what is left into the preserve root, off the event loop
     (`worktree.preserved`, with `remains: true`). Only what git would keep
     is copied: `git ls-files --cached --others --exclude-standard` over the
     remains, with the repository's git folder and a temporary index of the
     lane's commit (its branch, else its base) in which every `.gitignore` is
     marked skip-worktree, so a `.gitignore` git already deleted still
     applies. An ignored file (`.env.local`, `node_modules`), a manifest
     `[[copy]]` destination, a file already gone and a FIFO are never
     copied. If the remains then cannot be deleted, GC records
     `worktree.release-aborted` with that copy, and a retry reuses it instead
     of copying again.

   `<lane>` is the lane id when git accepts it as one ref-name component
   (letters, digits, `.`, `_` and `-`, not starting with `.` or `-`, no
   `..`, not ending in `.` or `.lock`), which every job lane's id is,
   since it already names the lane's `gru/<id>` branch. Any other id is
   written as `x-` followed by its UTF-8 bytes in hex (`a:b` →
   `x-613a62`).

   The `worktree.swept` event and the release answer carry
   `snapshot: { ref, sha, files }` (`files`: tracked paths the commit
   changes against HEAD), or `null` when there was nothing to save. Once the
   sweep completes, the owner gets one FYI board row per release that saved
   a snapshot or a preserve copy (kind `worktree-work-saved`, never FOR YOU)
   naming the lane and job, the ref, the count of tracked files and the
   command that applies it, with the repository path and the ref
   shell-quoted where a shell needs it (a path with a space works as
   pasted), and the preserve folder with its count of untracked files (a
   lane whose only work is untracked gets a row too). The snapshot is a plain commit on
   the lane's HEAD, so `git stash apply` does not take it;
   `git cherry-pick --no-commit` applies its edits, deletions and staged
   new files to any checkout, as a three-way merge:

   ```sh
   git for-each-ref refs/gru/preserved/        # every lane's snapshots
   git -C <repo> cherry-pick --no-commit refs/gru/preserved/<lane>/<stamp>
   git -C <repo> worktree add <dir> refs/gru/preserved/<lane>/<stamp>   # or look at it whole
   ```

   The autopilot release (issue #243 F-H1) no longer refuses a lane with
   uncommitted work; its fresh-containment proof stays.

   After the removal: **refresh the origin default**, then
   **containment-verified** branch delete. The tip must survive in another
   local branch/tag or the freshly verified origin default. Stale tracking
   refs (including a lane's cached upstream or an explicit remote base)
   never witness deletion; otherwise the branch is retained and noted.
   Swept-row retries and missing-tree reconciliation refresh before
   disposal too.
6. **Return the fresh head** — follow-on work starts from now.

## 4. Detached-for-reviews, branch-for-jobs (18d)

Jobs run `gru/<job>` branches in their own worktrees; review rounds
check out DETACHED worktrees at the ref under review (reviews never
grow branch debris). Review lanes record their owning job at creation —
every pause is answerable by construction (job id or round id).

## 5. Concurrency (18e)

Same-repo creation is sequential (git index/refs contention); every
creation resolves the FETCHED origin default-branch head (5a) — never a
held sha.

## 5a. Base provenance (owner incident 2026-09-23)

A lane's base is the `git fetch origin <default-branch>` tip of the
remote's default branch. The default is what the remote's LIVE HEAD
symref says (`ls-remote --symref`) — the authority, never a stale cached
`origin/HEAD` (a remote that renames main→trunk while main stays
fetchable would otherwise keep basing lanes on the demoted branch); when
the remote is unreachable, the cached `origin/HEAD` is used as a
declared guess the fetch must validate — and the repo's checked-out
branch is never consulted, because a host clone sitting on a lane
branch must not name the default. A default resolved from the cache
(probe unreachable) is NEVER recorded `origin` even when its fetch
succeeds — the lane takes the declared local-HEAD fallback with its
FYI, because a fetch proves the branch exists, not that it is the
default. The registry row records the base
SOURCE: `origin`
for a fetched live-verified base, `local-head-fallback` when the lane
branched from the host clone's local HEAD instead. The fallback is
never silent: the row carries it, the `worktree.created` event carries
it, and a `worktree-base-fallback` FYI notification names the stale
risk. Review lanes apply the same fetch discipline to `origin/<branch>`
refs; an unfetchable origin ref refuses outright — a stale review is a
wrong review, not an offline one. Lane release re-resolves through the
same contract, so follow-on work starts from the fetched head too; a
fetch failure there degrades identically (logged warning, local HEAD).

## 6. Lane slimming (#427)

A lane carries its git-ignored dependency folders (about 95% of a GC lane's
400 MB is `node_modules`), and a lane that waits keeps them. **Slimming**
deletes the `reclaim` folders of the manifest the lane was built from, and
keeps the lane folder, its git state and its edits. A slim lane is an
ordinary active lane: nothing that reads `status` treats it differently.

**One fixed manifest.** Slimming and restoring read
`.gru-command/worktree.toml` as committed at the lane's **base** (the
registry row's `sha`, the commit whose manifest bootstrap applied), never
the lane's HEAD and never the working tree. A minion's commit can neither
choose what a slim deletes nor what a restore runs. The slim records that
manifest's blob, and the restore runs exactly that blob. A lane whose base
has no manifest, no `reclaim`, or no `[[setup]]` (nothing could restore
it) is never slimmed.

**What setup makes, recorded at bootstrap.** When a lane is created and
bootstrapped, GC records `worktree.bootstrapped { id, manifest_blob,
setup_made }`: the `reclaim` entries absent before the manifest was applied
and present right after it. It is written once; a restore never rewrites
it, so what a restore requires never shrinks. A restore must bring those
back; any other entry is optional (build output a build or verify makes). A
lane with no bootstrap record (one created before GC recorded them) is
never slimmed, since a restore could not tell what it must bring back. The
blob is read in the source checkout at the commit the lane was made from,
so nothing reads the lane's HEAD or refs before the creation's custody
proof.

**What is deleted.** Each `reclaim` entry is deleted only when it exists,
no part of its path is a symbolic link, no manifest `[[link]]` `at` or
`[[copy]]` `to` lies at or under it (a restore runs only `[[setup]]`, so
those would never come back), `git ls-files` lists nothing tracked under
it, and `git check-ignore` says the repository ignores it (git runs with no
user or system config). Any other entry is skipped by name, and so is one
whose check fails (an error, not an answer); a missing one is skipped
silently.

**Recorded first.** The checks of every entry run before anything is
deleted. Then `worktree.slimmed { id, manifest, entries: [{ path, bytes }],
planned_bytes, skipped: [{ path, reason }] }` is written with the entries
it is about to delete and the bytes they would free, and only then are they
deleted. If that record cannot be written, nothing is deleted. From the
record on, the lane is slim, so a crash, a restart or a service stop part
way through leaves a lane whose next turn runs setup (setup is
idempotent). Each entry is checked again just before its delete, so one
that became a link since the plan is never followed. What was really freed
follows: `worktree.slim-done { id, freed_bytes, shared_bytes }` when every
delete completed, or `worktree.slim-incomplete { id, failed: [{ path,
reason }], partial, freed_bytes, shared_bytes }` when a delete failed or a
service stop cut the pass short; `partial` names the entries whose delete
began and did not finish, so part of each is gone. A delete checks the stop
at every path it removes, so a stop ends it there; an entry a stop cut
short counts no freed bytes. A pass the shutdown outran (the ledger closed
first) leaves a `worktree.slimmed` with no follow-up: the lane is slim, and
its next turn restores it. A half-deleted entry is never counted as there:
before setup runs, a restore finishes the delete of each entry the slim
named `partial` (or, after a slim with no follow-up at all, of each entry
it planned that is still there) and records `worktree.slim-completed { id,
entries }` (every entry finished so far, so a later restore never deletes
it again, even after a minion rebuilt it). Setup then makes it whole, or it
counts as missing: a required entry fails the restore as below, an optional
one is named in `not_recreated`. An entry whose delete cannot be finished
(its folder is read-only, say) is never counted whole either: a required
one fails the restore (the lane stays slim, the next turn retries), an
optional one is named in `not_recreated`.

**Bytes on disk.** Sizes come from an `lstat` walk that never follows a
link and counts each inode's allocated blocks (`blocks × 512`; its size
where a platform reports no blocks), folders included, and each inode
once. A file counts toward `bytes` and `freed_bytes` only when every one
of its hard links was met inside the walk (its `nlink`), since only then
does deleting the tree free it. A file also linked from outside (pnpm's
store, which hard-links every `node_modules` file on Linux) is counted as
`shared_bytes` instead: deleting it frees none of those blocks. Blocks a
copy-on-write clone shares with another file (an APFS clone, as some
package managers make) cannot be seen from here and are counted in full,
so on such a disk `freed_bytes` can exceed what the slim gave back. The
onboarding proof's sizes use the same walk, counting every inode once
whether or not it is linked from outside: what the lane holds, not what
deleting it frees.

**When a lane is slimmed.** It must be an active job or writer-child lane
with no process rooted in it (the sweep's enumeration), and the caller
must prove the job idle: not `laneIsBusy`, no minion turn holding or
waiting for a worker slot, no open provider wait for the job (its
continuation would be a minion turn), and no verification being readied,
queued or running. In this change only **report jobs** are slimmed
(deliverable review, artifact or investigation), once `delivered` and
idle, and only once the job's last activity is at least **30 minutes**
old, so a lane its commissioner is still talking to is not slimmed and
restored between directives. The clock reads
the job's newest activity event: `agent.state` (a minion's turn ends by
setting it idle), `job.delivered` or `job.status`, a restore of its lanes
(`worktree.rehydrated`), or the end of a verification run
(`verification.completed`), so a lane a verification just restored is not
slimmed again right after. An event whose time cannot be read counts as
recent, with one warn, never as idle. The 30 minutes are a constant for
now; a later change makes them a setting.

A slim is tried when the job moves to `delivered`, at service start, and
every five minutes, one job at a time across the service. The reconcile is
quiet: an already-slim lane, and a lane that can never be slimmed (what
its manifest says: none, no reclaim or setup, unparseable, or every entry
holds a link or copy destination), are skipped without a log line. Why a
lane is not slimmed is logged once, when it changes, and so are the
reclaim entries a slim skipped by name, with their reasons (a `warn`),
taken only from a slim that checked every entry (a decline before the
checks says nothing about them). A lane the manager declined for a passing
reason (a process rooted in it, a git or ledger failure) is not asked
again (no process enumeration, no git) until its job has a new turn,
delivery, verification, restore or claimed provider continuation, or one
reconcile interval (five minutes) has passed since it was asked, so a
process that exits on its own is noticed by the next reconcile however
long the declined slim took. Slimming is automatic (owner ruling
2026-10-16: lossless reclaim is automatic). The service's shutdown tells a
running slim pass to stop (it stops between entries, and a delete at its
next path) and waits for it at most five seconds, well inside the
shutdown's force-exit budget.

A slim, a restore and a **release** of the same lane take one lane lock,
so they never overlap: a release that arrives mid-slim waits for the slim,
and a turn granted mid-slim waits, then restores.

**Slim state** is a projection of events, not a column: a lane is slim
when its newest `worktree.slimmed` is newer than its newest
`worktree.rehydrated`.

**Restoring.** Every minion turn takes a worker slot through the pacing
gate. After the slot is granted and before the turn gets it, the gate runs
the job's restore: each slim active job or writer-child lane of the job
runs the `[[setup]]` of the manifest blob its slim recorded (links and
copies were never deleted; a slim recorded before slims named their blob
runs the base manifest's, with a warn). The turn holds its slot while setup
runs, and the turn's stop or cancel ends setup's process group. A
provider-recovery continuation takes no worker slot (by design, no second
capacity counter), so it calls the same restore directly, after its claim
and before its prompt; the service's stop ends its setup and the
continuation: nothing is spawned or prompted during shutdown, and its claim
is handed back (the wait is `recovered-pending` again,
`provider.continuation-released`), so the next start replays it. `POST
/api/verify` restores the job's lanes once its run holds a verification
slot and before its command spawns: restores share the verification budget
(`max_concurrent`), and the run's slot keeps the job busy, so no slim can
delete again before the command runs. A cancelled run (the verification
service stops) ends the restore's setup, never spawns its command (a
`verification.no-start`) and releases the slot. A client that disconnects
does not cancel a run (other streams may share it, and a reconnect
reconciles by request id), so it does not end a restore either.

A restore whose setup succeeds and brings back everything its setup made
at bootstrap is a restore: GC records `worktree.rehydrated { id, ms,
not_recreated? }`, and the lane is no longer slim. `not_recreated` names each other deleted entry setup did not
bring back; build output such as Rust's `target/` or a `dist/` comes back
with the next build or verify, as the onboarding proof allows (an entry may
appear after setup or after `verify.full`), and a later slim deletes it
again.

A setup that succeeds without bringing back what it made at bootstrap (a
`make deps` whose stamp file lies outside `reclaim`, so it thinks its work
is done) is a failed restore: GC records `worktree.rehydrate-failed { id,
error: "setup did not recreate X …", manifest, missing, reason:
"setup-incomplete" }`, the lane stays slim (each turn runs setup again) and
is never slimmed again, and Gru gets one **action-required** row for the
lane (kind `worktree.restore-incomplete`, closed once the lane is gone, as
for submodule work) naming what is missing and the likely stamp file.

When setup fails or is stopped, GC records `worktree.rehydrate-failed { id,
error, manifest? }` and logs a warning. The error is at most 4 KiB,
redacted before any cut: the failing command's reason line, then its
output tail cut from the raw streams as the onboarding proof cuts it (from
a line start, or of one longer line its last words, marked as starting
mid-line, or with no word to start at a note that the line is not shown, so
no fragment of a token is kept). The lane stays slim, so the next turn
tries again, and **the turn proceeds**: the minion has a shell and the
manifest.

**Not hibernation.** Removing the lane folder of an open job was decided
against on 2026-10-17: it needs a ledger migration, a decision at about 35
places that read a lane's status, a byte-identical reinstall of git admin
state and handoff receipts, and at least 8 restore entry points. Slimming
takes about 95% of the bytes with none of that.

## Endpoints

`POST /api/dispatch/release` — `{ job_id | round_id | worktree_id,
confirm_kill?, base_branch?, discard_submodule_work? }`. The paused response carries the FULL
process list (pid, command, evidence) and the ask note: that payload is
what a human acknowledges against. A submodule refusal answers 400 with
the `detail`, the `digest` and the `submodules` it found;
`discard_submodule_work: "<digest>"` lets an operator release destroy
exactly that work (audited), and any other value (`true` included) is
refused. A Silas release carrying it is refused. Authenticated like every
product surface.

## Configuration

```toml
[worktrees]
# root = "/absolute/path"          # default: <data_dir>/worktrees
# preserve_root = "/absolute/path" # default: <data_dir>/worktree-preserves
# setup_timeout_ms = 120000
```
