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

A recorded process row leaves `live` in one of three ways (#464):
- **`killed`**: a confirmed kill, the verification scheduler's reconcile
  of its own `registry` rows, or a reap of the lane's own processes
  (evidence `lane-token`, recorded `killed` directly, [§3a](#3a-lane-provenance-486));
- **`exited`, `not-enumerated`**: a release's fresh enumeration no longer
  finds the process rooted in the tree, and its pid is dead. A process
  still alive keeps its row `live` until the tree is swept, because an
  enumeration that could not read working directories cannot clear it;
- **`exited`, `worktree-swept`**: the tree reached `swept`. Every
  remaining row moves in the same transaction, except `registry` rows,
  which their own reconcile owns.

Each move is audited as a `worktree.processes-exited` event naming the
pids and the reason. Pid liveness never returns a row to `live`. Only a
pause's fresh enumeration can: it found a process rooted in the tree
again under that pid, so it is a lane process. Its `worktree.processes`
event names those pids as `revived`.

The orchestrator's OWN spawned services land there too: the verification
scheduler records every run it spawns for a lane (pid + argv, evidence
`registry`) and reconciles it on exit. A service the orchestrator started
for a lane is the lane's to tear down — not a stranger's.

Each row also carries the lane's **token** (`lane_token`, #486): random per
lane incarnation, minted when the row is registered (lanes not yet swept
when the column arrived got one then). Every session GC spawns in the lane
carries it, and so does everything that session starts
([§3a](#3a-lane-provenance-486)).

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
       copies them (unless the submodule's `.gitmodules` at the base says
       `ignore = untracked` or `all`), all but what the repository around
       it ignores: `git ls-files --others --exclude-standard` lists them
       there with an index that does not exist, so no gitlink hides the
       folder.

     (An untracked folder holding a `.git` is no gitlink: step 1 copies it
     whole, its `.git` and commits with it, all but what that repository
     ignores.) A release refuses (never
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
   with it, all but what that repository ignores (`git ls-files --others
   --ignored --exclude-standard --directory` there, so its `.env.local`
   stays out; an ignored folder in it that is, or holds, a repository, by
   the walk of step 0, is copied, the same rule applied to each one); the
   untracked content of nested repositories too, at any depth
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
   Then **reap the lane's own processes** (#486): a process rooted in the
   tree that carries the lane's token is reaped the same way, recorded
   killed with evidence `lane-token` ([§3a](#3a-lane-provenance-486)). A
   release that does not pause (`onLiveProcess: 'refuse'`, the disk
   budget's) reaps neither.
3. **Enumerate** processes rooted in the tree: argv **path-boundary**
   match (a sibling lane `job-a-2` is never confused with `job-a`) OR
   the process's actual **cwd** (lsof on macOS, procfs on Linux; other
   platforms argv-only, declared).
4. **Pause and ask** — any other live process pauses the sweep (needs-owner
   escalation — a destructive step is the owner's ruling) and touches
   nothing: one with no lane token, another lane's token, or an
   environment GC cannot read, or one carrying this lane's token while a
   session GC runs in the lane is still busy. `confirm_kill` answers the
   RECORDED ask: it kills exactly the acknowledged pids (never a fresh
   enumeration — later arrivals were never acknowledged), and only while
   the fresh enumeration still finds each rooted in the tree running the
   command it was recorded with (#486: an answer given late never reaches a
   pid that now runs another command), with a SIGTERM grace before
   SIGKILL. Survivors re-pause; newcomers get their own ask;
   `confirm_kill` without a recorded pause is not honored. Silent kills
   do not exist for processes nothing ties to the lane. The owner's card
   ([§3a](#3a-lane-provenance-486)) names what runs and offers that answer
   as its one action.
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
     no reflog. GC never deletes these refs on its own: once the lane's job
     has been over for 30 days, it proposes their deletion to the owner
     ([§7](#7-expiry-moved-repositories-and-reset-427)), as it does the
     preserve copies.
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
     applies. Every gitlink leaves that index too: a submodule folder
     holding a `.git` is listed as a repository and copied whole like an
     untracked one (all but what it ignores, as in step 1), and one holding
     none (never initialized, or its git folder gone with the lane's) file
     by file under those rules. An ignored folder that is, or holds, a
     repository (the walk of step 0: three levels deep, never into a
     `node_modules`, never through a link) is kept whole, by the same rule.
     Any other ignored file (`.env.local`, `node_modules`), a manifest
     `[[copy]]` destination, a file already gone and a FIFO are never
     copied. If the remains then cannot be deleted, GC records
     `worktree.release-aborted` with that copy, and a retry reuses it instead
     of copying again. **Limit:** the remains are judged by the ignore rules
     of the lane's commit, since the lane's index went with its git folder.
     A file the minion staged with `git add -f`, or one an uncommitted
     `.gitignore` edit stopped ignoring, is recovered from the snapshot ref
     when GC took one before the removal (a release of GC's that stopped
     part way); a removal the owner ran by hand, outside GC, took no
     snapshot, and such a file is not copied.

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

## 3a. Lane provenance (#486)

A minion's tool calls start processes that outlive them: a browser
automation daemon, a headless Chrome, a dev server. They double-fork or are
reparented to pid 1, so nothing in the process tree ties them to the session
any more, and before #486 every one paused its lane's sweep and asked the
owner about bare pids.

- **The token.** When the runtime registry spawns a session whose cwd is a
  registered lane not yet swept (the row whose `path` is exactly that cwd),
  the session's environment carries `GRU_LANE_TOKEN=<the row's token>` and,
  for a lane with a job, `GRU_LANE_JOB=<job id>`: on claude-code, the CLI's
  environment (every CLI child of the session: turns and compaction); on
  Pi, every command of its `bash` tool (GC supplies Pi's own bash tool,
  built with the session's shell settings and a spawn hook that adds them).
  Every descendant inherits them, a daemon that detached included. GC never
  sets them in its own environment, and drops any it inherited (a service
  started from inside a lane) before a session's own: a session carries
  only the lane GC assigned it, and one outside a lane carries none. An
  isolated Pi review session has no bash, so it starts no process to carry
  them.
- **Reading it.** On Linux GC reads `/proc/<pid>/environ`; on macOS
  `ps -E`, whose environment follows the command line, which must still be
  the one the listing showed (a process that exec'd since, or a recycled
  pid, reads as unreadable). **Limits:** macOS shows no environment for a
  system binary (`/bin/sh`, `/bin/sleep`), Linux none for a non-dumpable
  process, and other platforms none at all: such a process keeps the ask. A
  process that clears its environment drops the token and keeps the ask
  too.
- **At the sweep** (step 2), a process rooted in the tree whose token is
  exactly the lane's is reaped (process group SIGTERM, grace, SIGKILL) and
  recorded `killed` with evidence `lane-token`, with a
  `worktree.lane-processes-reaped { id, path, trigger: "sweep", pids,
  survivors }` event. Dual-keyed: the token is read again just before each
  signal, so a pid recycled between the enumeration and the kill is never
  signalled. Never while a session GC runs in the lane is busy there (a
  call in flight, a turn streaming or being spawned, a compaction or a
  disposal): its own processes carry the token too. That is checked again
  just before the SIGTERM and before the SIGKILL. A survivor stays for the
  ask. A pid already on the record keeps its row; the reap records it
  with evidence `lane-token`. (A row recorded live again after it left
  `live` takes the evidence it is seen by then: it is another process, or
  one seen afresh.)
- **When the turns end.** Once every session on a lane has settled its
  calls, or been disposed, the registry tells the manager, which reaps the
  same way right away (`trigger: "turn-settled"`), listing off the event
  loop and under the lane's lock. Skipped for a lane that is not active,
  while a verification run GC spawned owns the tree (a live `registry`
  row: the run may use what the minion started), and once the service is
  stopping (its shutdown disposes every session): a reap the stop
  overtakes signals nothing more. A review runs in its own
  lane ([§4](#4-detached-for-reviews-branch-for-jobs-18d)), whose sessions
  decide when that lane is quiet. The worker rule blocks tell minions to
  stop what they start before their turn ends, and that GC stops what they
  leave.
- **The card.** What still runs is not provably the lane's. The pause's
  FOR YOU card (`worktree-sweep-paused:<lane>:<pause>`, its id too; the
  pause's `worktree.paused` event carries `pause_id`, and the base branch
  its release named) groups the processes by name (`Google Chrome for
  Testing ×11 + agent-browser`: a macOS app's helpers group under its
  outermost `.app` bundle, anything else under its executable), says when
  they started, and gives each name and reason its pids, start times and
  working directory and why GC did not stop them: no lane token, another
  lane's token (named), an environment it could not read, or this lane's
  token while a session was busy. Its one option, **Stop these N processes
  and finish the sweep**, is carried out as an operator's `confirm_kill`
  limited to the pids that card named, with that base branch, and, like an
  operator's release, never while a child worker of the lane has not
  finished: a survivor or a process the answer did not cover pauses again
  with a new card, and the answered card closes saying what happened (a
  sweep that finishes closes it as swept, naming the answer). An answer
  that has to wait (a child worker that has not finished, or a release
  that failed) leaves the card open and answered, Gru gets one
  action-required row per card naming why (`worktree.sweep-answer-waiting`,
  resolved once the answer is carried out or the lane is swept), and the
  next pass tries again: passes run at each answer, at start, after moved
  lanes are reconnected, and at the hourly reconcile. A newer pause of the
  lane withdraws its older unanswered cards (a notice from before #486
  too), and a sweep settles only that lane's cards, matched exactly. No
  answer is started once the service is stopping.

## 4. Detached-for-reviews, branch-for-jobs (18d)

Jobs run `gru/<job>` branches in their own worktrees; review rounds
check out DETACHED worktrees at the ref under review (reviews never
grow branch debris). Review lanes record their owning job at creation —
every pause is answerable by construction (job id or round id).

## 4a. Creation custody across an interruption (issue #453)

A lane's branch is created inside one prepared `git update-ref`
transaction, and that transaction can commit without settling: the owned
child outlives its close budget, or the service dies after `commit: ok`.
The ref then exists at the fixed base while the checkout, the handoff
receipt and the ledger row do not — and the token that proved authorship
used to live only in the creating process's memory, so the taken branch
name refused every retry.

Before the transaction starts, a creation receipt is published durably at
`<common-dir>/gru-creation/<hash-of-branch>.json` (fsynced file and
directory). It binds the lane identity (job/round/child, kind, checkout
path), the repository, the branch, the fixed base sha, the base
provenance, and the creation token. It is cleared once the lane is
registered or rolled back under its own proof.

A retry of the same creation reads that receipt and refuses anything it
cannot attribute: a different lane or repository, a lane the ledger
already holds (any status — that id is not reusable), a changed tip, a
reflog that no longer carries the token, a symbolic ref, an unsettled
`refs/heads/<branch>.lock`, a holder in `git worktree list`, or an
administration entry that claims the lane path while being torn,
duplicated or locked for another token. A ref it cannot read at all is
also a refusal: only git's own "no such ref" counts as absence. Only with
the receipt intact does it act: a committed ref with no checkout is
resumed at ITS recorded base (the creation is never re-based onto a moved
head), and a checkout whose admin entry carries the same token is rolled
back and remade. On the resume path the retry performs no second creation
transaction, so a lost response cannot author a duplicate branch; a
transaction that never committed is closed as spent and a fresh one
starts.

Only branch-creating lanes keep a receipt — job lanes and writer children.
Review lanes and read-only child lanes create no branch, so a crash inside
their `worktree add` is no more reconcilable than before.

A ref with no receipt is still refused: absence of a record is never
evidence that an earlier attempt did not run. A receipt whose every
resource is gone (no ref, no ref lock, no administration entry, no
checkout) protects nothing, and is closed rather than left to fence a
branch after the lane root moves.

Reconciliation is serialized in-process (`withRepoLock`). The receipt's
host and pid are diagnostic: they are never read as cessation OR liveness
proof, so two service processes sharing one repository are not
coordinated by this receipt (a pid namespace reset makes a recorded pid
look live again, which is why it is not a gate).

## 4b. Same-job retained initial-creation continuation

`POST /api/dispatch/creation-continuation` is a narrow authenticated control
for one already-recorded, blocked PR-owing initial dispatch whose branch ref
was committed but whose checkout and lane registration did not complete. Its
body is exactly `{ "job_id": "…", "request_id": "…" }`; it reuses the
original job row, unique `job.handoff`, immutable briefing, branch, retained
receipt, fixed base and `base_source`. It does not call `addJob`, append a new
handoff, or accept caller-supplied source/briefing/base fields. A job with an
accepted amendment, previous phase-handoff, report/PR target, worker, lane,
admission, live directive or pending re-brief is outside this control and is
refused, as is a request id that names a directive request. The handoff
path's own leaf must be the job's recorded repository (dispatch derived it so,
a symlinked path included) and the path must resolve to the repository the
manager inspects; the continuation dispatches through that same path.

Every job branch creation, ordinary dispatch included, journals one
`job.creation-producer-settled` event per receipt token when its Git child's
own `close` shows that the child exited and every holder released its pipes
(a descendant that redirected its output can outlive that). A child that
exited while something still holds the pipes is watched for up to ten
minutes; a close caused by GC releasing those pipes proves nothing, and the
producer then stays UNKNOWN. A failed write is logged and never fails the
creation. The receipt token is bound by its SHA-256 digest; the raw token
never reaches the readback, and a dispatch failure's job note, events, HTTP
detail and log line redact it. Receipt
host/PID, a missing PID, service restart and ref commitment are not
producer-cessation evidence. Without the settlement the request is refused and
custody remains UNKNOWN.

A continuation waits at the ordinary disk floor (the owner may bin or park the
job meanwhile), then takes the job admission, refuses a live directive or
pending re-brief that started during the wait, and calls WorktreeManager's
guarded reconciliation with a strict retained-only policy. The receipt must be
the one the request accepted (same token digest and settlement), and it and
the exact direct branch ref must remain present and unchanged, including the
receipt-matched reflog and repository/worktree-holder fences. Missing
receipt/ref cannot clear the receipt and fall through to the ordinary new-base
branch; mismatch, lock, symbolic ref, foreign checkout/admin/holder and
unreadable evidence refuse without continuation cleanup, before adoption or
after it. Any other failure before registration, a failing `[[setup]]`
included, rolls the checkout back under the receipt's own token and keeps the
ref and receipt: readback says `failed` with the retained custody, and a later
request adopts them again. A setup step that fails while a process of any step
still runs keeps everything and reads `custody-unknown`, as does an
unconfirmed rollback. A failure before the manager starts adopting (the
repository path gone, say) touches nothing and reads `failed`. A failure after
registration reads `custody-unknown`: the registry row holds the lane and the
receipt may already be spent. A registered lane goes through the ordinary
worker pacing gate, spawn and delivery path. A minion GC disposes before its
prompt has its lane swept and reads `failed` once the disposal resolved; a
failed disposal leaves the agent row as it was and reads `custody-unknown`.

The durable request history names its generation and payload digest and
readback distinguishes `accepted`, `queued`, `admitted`, `delivered`, `failed`,
`refused` and `custody-unknown`. Read back one exact request with
`GET /api/dispatch/creation-continuation?job_id=…&request_id=…` (same bearer
authorization). Readback reports the original handoff/briefing digest, branch,
base/provenance, producer-settlement event, registered worktree, queue,
spawn and correlated delivery evidence. The delivery is correlated by
`creation_continuation_request_id` and `creation_continuation_generation` on
`job.delivered`, never the `request_id` that directive correlation reads. It
never reports a prompt as delivered from acceptance or job status alone.

Exact POST retries return the durable readback and never relaunch. A different
request cannot compete with an accepted, queued, admitted or custody-unknown
generation. If process ownership is lost before the delivery receipt, or a
sent prompt's turn fails while the service is stopping, readback reports
`custody-unknown`; neither GET nor retry resumes it. The unknown request
remains a stop, not an automatic replay invitation. This route is not a
generic retry/migration command, does not recover historical directives, and
does not itself authorize continuation of any live target. Re-read every
target's exact producer, receipt/ref/reflog, checkout, holder and admission
guards immediately before owner-authorized use.

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
it, `git check-ignore` says the repository ignores it (git runs with no
user or system config), and it neither is nor holds a git repository (a
`.git` at it or at most three levels below it, never into a `node_modules`,
never through a link: "it holds a git repository (vendor/lib/.git)"), so a
slim never deletes commits. Any other entry is skipped by name, and so is one
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

## 7. Expiry, moved repositories and reset (#427)

**Review artifacts expire.** Once a job has been terminal (merged, done or
binned) for **14 days**, GC empties each of its round folders
(`<data_dir>/reviews/<round>`) except `consolidated.json`, and deletes its
`<data_dir>/reviews/fallback-gate/<job>-<time>-<random>` folders. This loses
nothing: the ledger keeps the verdicts and findings, the PR keeps the
published review, and nothing reviews a terminal job again. Each round's
`consolidated.json` (small JSON, kept only as a regular file) stays because
its readers outlive the job: the decision backtest's labelled-case corpus
(`gru-decisions extract-cases --surface same_blocker --artifact-root
<data_dir>/reviews`) and the digest's blocker reader. When a job ended is the
time of its newest `job.status` to that status; a time GC cannot read is
never old (one warn). Each pass records `reviews.expired { job_id, rounds,
fallback_gates, bytes }` for each job it deleted something of. A file whose
delete fails stays, and the next pass tries it again. An open job's folders,
and the folders of a round or job the ledger does not know, are never
touched.

**Saved work is proposed, never deleted on its own.** Preserve copies
(`<preserve_root>/<lane>/<stamp>`) and snapshot refs
(`refs/gru/preserved/<lane>/<stamp>`) hold minion work (owner ruling
2026-10-16: anything that loses data stays a FOR YOU proposal). Once a swept
lane's job has been terminal for **30 days**, GC posts one FOR YOU card per
repository (kind `worktree.preserve-expiry`, a typed owner decision) listing
each expired copy and ref, its size (a copy's bytes on disk; a ref's
objects no other ref reaches, `git rev-list --objects --disk-usage`), and
how to restore it (`cp -R <copy>/. <repo>`, `git -C <repo> cherry-pick
--no-commit <ref>`). The list is recorded before the card is posted
(`preserves.proposed`). **Accept** deletes exactly what that first record
listed (a later record under the same card is never what the owner saw) and
nothing else, each item re-checked first: a copy only while it is still that
released lane's `<preserve_root>/<lane>/<stamp>` folder (never a link, nor
reached through one) with its listed size; a ref only while it is that
released lane's `refs/gru/preserved/<lane>/<stamp>` in this repository and
still names the listed commit (`git update-ref -d <ref> <sha>`). Anything
that changed is kept, named, and proposed again as it is now; nothing
outside those roots is ever deleted. Work that expired after the card waits
for the next one. A delete that fails keeps the card open and records what
that pass deleted (`preserves.delete-incomplete`); the next pass deletes what
is left, and `preserves.deleted` then names everything GC deleted for the
card and the bytes of every pass.
**Decline** keeps everything (`preserves.declined`), and GC proposes again
30 days later. A repository with an open card gets no second one.

Both run at start and every hour, with no migration: ledger events and
notification rows only. The 14 and 30 days are constants for now.

**Moved repositories are repaired by identity.** Moving a managed
repository's folder used to break every lane that pointed at it: a lane's
`.git` file names its administration inside the repository's `.git`, which
moved. At service start, before any turn runs, and at the hourly reconcile,
GC checks every lane (active or paused, its folder present) whose git link
no longer reaches the repository at its registry `repo_path`. The managed
repository of the same name, resolved now (after you update
`workspace_root`), holds the same repository when both hold:

- **a shared root commit**: the root commits reachable from all refs
  (`git rev-list --max-parents=0 --all`) overlap, so an orphan branch checked
  out (`gh-pages`) or a deepened shallow clone is still the same repository;
- **the same `origin` URL**, when both have one, compared as the place it
  names: host (any letter case) and path, without the scheme, user, port, a
  trailing `/` or `.git`, so `https://h/o/r.git` and `git@h:o/r` match.

The lane's side is `worktree.repo-identity { id, repo_path, roots, origin }`,
recorded when a lane is created, and by the check for a lane whose link
works and has none for its place: a lane made before identities were
recorded gets its record, origin included, at its first check while its
repository is still where the registry says. One whose repository was
already gone has only its base commit, whose roots are read in the
candidate, and no origin to compare; the check says so in the log. A git
failure is never a verdict: the lane is left as it is, the reason logged
once, and the next check judges it again.

The same repository gets the lane back: `git worktree repair <lane>` runs
from the new place, the lane's link must then reach it, and the registry's
`repo_path` moves there (no migration: the column exists), recorded as
`worktree.repo-moved { id, from, to }`. In the same transaction, as the very
next event, the lane's creation handoff (the custody receipt every turn,
verify and release checks) is re-bound to the new place:
`worktree.handoff-rebound { id, from, to, move_seq }`, two receipts that
differ only in where the repository, its git directory and the lane's
administration are. Custody accepts a rebinding only when it starts from the
binding issued before it, changes nothing else, and is paired with that
lane's move (`move_seq` names the event right before it); no custom event
may write either kind. The re-bound receipt is then written in the lane's
administration, and a stop between the record and that write is finished by
the next check, even after the repository moved again meanwhile: a receipt
that is any earlier binding of the lane's own issued chain is replaced by the
newest one. The lane's next turn, verify and release work as before.

A new administration is taken only when a move explains it: the
administration the handoff was issued with is gone (or is a link to the new
one), its id (its name under `worktrees/`) is unchanged, and git registers
the lane exactly once in the repository's common directory (`git worktree
list`). Otherwise, as when a second administration was made for the lane and
its `.git` pointed at it, nothing is re-bound and no move is recorded: the
lane's custody stays refused, and Gru gets one action-required row
(`worktree.lane-tampered`) naming the lane. The ledger itself refuses a move
to the same `repo_path` unless the repository's real place or its git
directory moved.

Each check reads each managed name's place and each repository's identity
once, each base commit's root commits once per repository, and the ledger's
handoff completions once (never once per lane). It runs on the event loop,
so one slice of it repairs at most 10 lanes and starts no repair after
250 ms but its first: start runs one slice before any turn, and each
reconcile (the first right after start) runs slices, letting the service's
timers and requests run between them, until no lane waits. A lane waiting
for its slice is refused its turns until it is repaired.

Paths are compared as the filesystem resolves them. A repository moved with
a link left at its old place still reaches its lanes through the link, but
their receipts name the old place: the check re-binds them to where the
repository really is, and their `repo_path` follows the managed name when it
resolves there. A repository whose own git directory moved
(`--separate-git-dir`), its folder in place, is repaired the same way and
re-bound to the moved git directory, its `repo_path` unchanged. A released
(swept) lane whose repository moved follows it too, at each reconcile
(`worktree.repo-moved`, nothing to repair), so its snapshot refs are still
proposed for expiry and the card's restore commands name where the
repository is now. That follow runs its git off the event loop and yields
between rows, and a released lane found to be of a different repository is
not judged again while the name holds that same repository.

A **different** repository under the name gets one FOR YOU card for the lane
(kind `worktree.repo-mismatch`, a typed owner decision): discarding a lane
loses whatever it holds. **Accept** records `worktree.discarded { id, path,
repo_path, reason }` (once), deletes the lane folder and marks the lane
swept, unless the lane reaches its repository again by then. It never runs
over live processes: while the lane is paused over processes that still run,
has any process rooted in it, or is no real folder under the lanes root,
nothing is deleted and the card stays open until a later reconcile can.
**Decline** keeps the lane; the card is not posted again while the name
resolves to that repository. A card whose lane was reconnected or swept
before anyone answered is withdrawn; when the name later resolves to that
place again, a new card (a new id) asks. A lane whose repository is gone and whose name is not
managed, or not available, is only logged, and so is one whose name holds the
same repository without the lane's record in it (a fresh clone, not the moved
folder): `git worktree repair` cannot reconnect a lane the repository does
not know. Each check judges such a lane again.

**`gru reset`** is the clean fresh start that keeps `config.toml`
(deleting `~/.gru-command` by hand also deleted the config and left dangling
worktree registrations and `gru/*` branches in every managed repository):

```sh
gru reset [--yes] [--delete-branches] [--delete-refs]
```

1. It refuses unless the service is provably stopped, naming how to stop it
   (`gru stop`): something listening on its
   port, a `/health` that gives any answer but a refused connection (a
   timeout included), or a ledger another process holds open (the service
   keeps no pid file; SQLite's lock on `ledger/ledger.db` is held while it
   runs) all refuse. It checks again after your confirmation, immediately
   before the first change. From then until it is done it holds its own
   lock file, `reset.lock` in the data directory (kept, never deleted): a
   service that starts meanwhile refuses to open its ledger and exits. It
   also holds the ledger's lock, and deletes the ledger last.
2. It lists what it will do, per repository and for the data directory.
3. With `--yes`, or a `y` at the terminal, it:
   - removes every GC lane with `git worktree remove --force --force` (lanes
     are created locked) in the repository that registers it: the managed
     repositories' lanes, and the lanes of a repository that is not managed
     or not available now, found under `[worktrees] root`, in the data
     directory or in the ledger's registry and read from their own `.git`
     file. A GC lane is a worktree the registry names, or one under the lanes
     root on a `gru/*` branch, locked by GC's creation or holding GC's
     handoff receipt; any other worktree is yours and is never touched, even
     under the lanes root or in the data directory at any depth (a folder
     holding a repository's own `.git` is searched too, never the `.git`
     itself). A lane folder its
     repository does not register is deleted as a folder; one whose
     repository cannot be found is left and named. Then it runs
     `git worktree prune` in each managed repository, unless that would also
     drop one of your own worktrees whose folder is missing (then it says so
     and skips the prune);
   - deletes `gru/*` branches only with `--delete-branches` (one your own
     worktree has checked out is kept, named), and `refs/gru/*` (the
     snapshot refs) only with `--delete-refs`;
   - deletes the data directory's contents except `config.toml` and the
     install's own files (`identity/`, `credentials/`, `perkins/`,
     `onboarding-consent.json`, `wizard-draft.json`, the service unit's
     `logs/launchd.*.log` and `reset.lock`), keeping the directory. A
     worktree or checkout of yours in it is kept with every folder that
     leads to it, and with its repository when that is in the data
     directory too: the checkout around its `.git` folder (only that `.git`
     when the checkout is the data directory itself), a bare repository, a
     `--separate-git-dir` git directory beside it, or a submodule's
     `.git/modules/<name>`; only what lies beside them is deleted. The
     `ledger/` folder goes last, after every other entry.

It prints what it removed. It never touches your own branches, worktrees or
files. The data directory is compared as the filesystem resolves it (a link
followed once, the letter case made canonical, so on a case-insensitive
volume `~/WORKSPACE` is your workspace), by path segment: one that is or holds your home directory
or the filesystem root, holds the workspace root or a managed repository,
holds the install or lies inside it, is refused. The delete never follows a
link: a link is deleted as a link. When a lane is not removed, the data
directory is left as it was and reset exits 1. A lane root or preserve root
configured outside the data directory is left as it is. Start the service again with
`./install.sh --service` (or `npm start`).

## 8. Disk view, budget and floor (#427)

The incident that started #427 was 68 GB. Three `[worktrees]` keys keep GC
inside a size and off a full disk ([CONFIG.md](./CONFIG.md)).

**The view.** `GET /api/disk`, and the board's disk pair next to the verify
queue, show GC's usage under `data_dir` by category: each live lane (job,
review or child, slim or not), review artifacts (`reviews/`), preserve copies
(`preserve_root`), onboarding probes, the ledger database (`ledger/`), logs, and
everything else under `data_dir`. They also show the free space and total
(`fs.statfs`) of each disk the floor watches: the one lanes are created on
(`[worktrees] root`) and `data_dir`'s, one entry when they share a disk. The
budget and the floor are shown too. Usage is the walk of
[§6](#6-lane-slimming-427): allocated blocks, never through a link, with each
hard-linked file counted once within a walk (each lane, each category). A file
also hard-linked from outside its walk (a package store's links) is shown
apart, as shared bytes, and is not in the usage: deleting the walk frees none
of it. Blocks an APFS clone shares with another file cannot be detected and
are counted in full; the view's note says so. The walk is async, runs at most
once a minute and is cached; a reclaim that freed space drops the cache, so
the next numbers are walked afresh. A lane root or preserve root configured
outside `data_dir` still counts as GC's.

**The budget** (`disk_budget_gb`, default 30) is checked at start, every five
minutes and after each lane is created. Over it, with `reclaim_mode =
"automatic"` (the default), GC frees space losslessly, in this order. It stops
once its usage is at most 90% of the budget (27 GB of 30) and the disks are at
or above the floor. The next reclaim starts only once GC is over the budget
again, so a lane made right after a reclaim does not start another.

1. **Release the lanes of finished jobs** (merged, done or binned) that have
   settled, largest first. This is the existing release of
   [§3](#3-preserve-first-ordered-sweep-18c), unattended as the autopilot's
   (`requireReleaseProofs`), which saves the lane's work before removing it. A
   lane is released only when all of these hold:
   - the job ended at least 10 minutes ago;
   - no review round of the job is pending or live;
   - no verification run of the job is unsettled;
   - no child worker of the job is unfinished (for the job's lane and each
     child's lane);
   - the lane's release is not paused;
   - no active `sweep-ack` decision holds it;
   - no process is rooted in it (one listing per pass).

   A process that appears while the release copies the lane's untracked files
   makes it refuse rather than pause: no owner card, nothing killed, and no
   preserve copy left behind. A lane whose release refused is not asked again
   until its job has news (a turn, a delivery, a verification, a restore) or an
   hour has passed. A pass runs at most three releases (each makes synchronous
   git calls); the rest follow in a pass 15 seconds later.
2. **Delete the review folders of finished jobs**, without
   [§7](#7-expiry-moved-repositories-and-reset-427)'s 14-day wait, keeping what
   expiry keeps (an open job's folders, a round or job the ledger does not
   know, each round's `consolidated.json`). A job with a review round pending
   or live keeps its folders, and a round folder holding nothing but its
   `consolidated.json` is not listed again. The folders are listed once per
   pass, and a step deletes exactly the folders it names, each checked again.
3. **Slim idle lanes**, oldest idle first: any job or writer-child lane whose
   job is not `working` (or `dispatched`), with no minion turn holding or
   waiting for a worker slot, no verification, no provider wait, no live
   directive, re-brief or revision and no unfinished child worker, and whose
   job's last activity (a turn's end, a delivery, a restore of its lanes, a
   verification's end) is at least 30 minutes old. A lane restored in the last
   30 minutes is never slimmed again. The slim is
   [§6](#6-lane-slimming-427)'s `slim()`, with all its checks; a lane it
   declines is skipped.

Each step is recorded as `disk.reclaim-step { step, lane? | rounds and
fallback_gates, job_id, outcome, freed_bytes, reason, trigger }`, and each pass
that ran a step as `disk.reclaim-pass` (with how many releases it left for the
next). A skip is recorded once per kind of reason: its numbers (a pid, a count)
are left out, so a watcher that respawns under a new pid is not recorded
again, and a different reason is. What a step freed is the walk of what it
touched: a released lane's bytes less its preserve copy, the review folders
before and after, a slimmed lane before and after. The service's shutdown waits up to
five seconds for a step in flight.

**`reclaim_mode = "proposed"`** does none of that. GC posts one FOR YOU card
(kind `disk.reclaim-proposal`, a typed owner decision) listing exactly the steps
it would take, each with the space it would free, stopping the list once the
estimates reach 90% of the budget and the floor. The card lists at most three
releases, and no slim that `slim()` would refuse for good: a lane with no
bootstrap record, one whose restore came back incomplete, or a reclaim folder
a `[[link]]` or `[[copy]]` destination lies under. The list is recorded first
(`disk.reclaim-proposed`). **Accept** runs exactly those steps, in order, each
checked again (a lane in use by then is skipped; a review step deletes only
the folders it names), stopping once satisfied. An Accept that leaves GC over
its budget or the disk below the floor tells Gru (the row below), and no new
card is posted for one check interval (five minutes). **Decline** changes
nothing (`disk.reclaim-declined`, with GC's usage when the owner declined) and
holds until GC's usage grows by another 10% of the budget past that usage (of
the floor, when the budget is off). Once the condition clears, the hold ends
(`disk.reclaim-hold-ended`). While a Decline holds and lanes wait at the floor,
Gru is told, so nothing waits silently. A card nobody answered is withdrawn
when the condition clears. One card at a time. When `reclaim_mode` becomes
`"automatic"` (or the budget and floor are both turned off), the next start
closes any open card: an unanswered one is withdrawn by GC, and an answered
one is closed without being carried out.

**The floor** (`min_free_disk_gb`, default 10). Before a job lane or a
writer-child lane is created, the free space of each watched disk is read.
While one is below the floor the lane waits in a FIFO (`disk.floor-queued`),
its note saying what GC is doing about it, with the free space rounded down
(9.96 GB reads "9.9 GB"), and naming the disk when lanes and `data_dir` are on
different disks:

- "queued: 6.0 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb);
  GC is checking what it can free", when it starts to wait;
- "...; GC is freeing space", while reclaim steps run;
- "...; the reclaim card is waiting for the owner's decision", in
  `"proposed"` mode;
- "...; nothing more can be freed without losing work; Gru has been told", when
  nothing is left.

A job lane's note is the job's; a writer child's note goes on the child's
record (`child.note`), never over its parent job's. The board's disk pair
lists each waiting lane with its note. GC runs the reclaim at once, in any
mode (in `"proposed"` mode it posts the card at once), without waiting for a
usage walk. Once every watched disk is at or above the floor (read every 15
seconds, and after each reclaim step), the first lane in the queue is created
(`disk.floor-admitted`, and its note says it was admitted). The next is
admitted only after that lane's creation finished (or 30 seconds passed) and
the free space was read again, so a crossing never lets every waiting lane
fill the disk at once. A lane that arrives with nobody queued and the floor
met goes straight through. Binning, parking or blocking a job ends its lane's
wait, and so does cancelling a writer child or stopping the service. Review
lanes never wait: they help work finish. A free space that cannot be read
cannot be judged: the lane is created, with an error log. A floor at or above a
watched disk's total size could never be met: GC treats it as off (no lane
waits for it, and nothing is freed for it), logs an error and posts one
action-required row for Gru (kind `disk.floor-impossible`, producer-resolved).
That row closes itself once a restart finds the floor fits.

**Nothing left to free.** Over the budget or under the floor with nothing
reclaimable left, Gru gets one **action-required** row (kind
`disk.nothing-to-free`, producer-resolved) naming GC's usage by category, the
largest live lanes and how much of each watched disk is used by things that
are not GC's. It closes itself once GC is under its budget and the disk at or
above the floor, or when a new reclaim card shows something can be freed again.

`0` turns the budget or the floor off; with both off nothing is checked (the
next start closes GC's open disk rows and cards), and the view is still shown.
The budget never stops or refuses a heist.

## Endpoints

`GET /api/disk` — the disk view of [§8](#8-disk-view-budget-and-floor-427):
`usage { computedAt, totalBytes, sharedBytes, categories, lanes }` (null until
the first walk), `volumes [{ names, path, freeBytes, totalBytes, notGcBytes,
belowFloor }]` (each watched disk), `unreadable` (a watched folder whose disk
could not be read), `budgetBytes`, `floorBytes`, `floorOff` (why a configured
floor is treated as off, or null), `reclaimMode`, `overBudget`, `belowFloor`,
`floorQueue` and the usage `note` (shared bytes, APFS clones). Authenticated
like every product surface.

`POST /api/dispatch/release` — `{ job_id | round_id | worktree_id,
confirm_kill?, base_branch?, discard_submodule_work? }`. The paused response carries the FULL
process list (pid, command, evidence, and the working directory when the
listing read it) and the ask note: that payload is
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
# disk_budget_gb = 30              # 0 disables the budget (§8)
# min_free_disk_gb = 10            # 0 disables the floor (§8)
# reclaim_mode = "automatic"       # or "proposed": one FOR YOU card (§8)
```
