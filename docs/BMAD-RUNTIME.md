# GC-managed BMAD runtime (historical/transitional)

For the new directly editable GC-owned resource package, explicit invocation
context and local integrity maintenance, see [GC-WORKFLOWS.md](GC-WORKFLOWS.md).
This document describes the retained #283 package and current session/setup
consumers until the separate #294/#295 cutover. It is not the maintenance
procedure for new GC workflows, and shipping those resources does not migrate
or remove anything described here.

Gru Command (GC) ships the BMAD framework its build workflow uses. A managed
repository does not need its own BMAD installation for GC builds: it keeps
only its own settings, context and generated work. (Issue #283.)

## What is bundled

`resources/bmad-runtime/` holds two trees and a manifest:

| Tree | Content | Rule |
|------|---------|------|
| `upstream/` | Files from the pinned `bmad-method` npm package, byte-for-byte: `LICENSE`, `src/scripts/render_skill.py`, `src/scripts/config_utils.py`, and the whole `src/bmm-skills/ship/bmad-build/` skill | never edited |
| `gc/` | The GC customization layer (`gru-command-bmad`) | small, reviewed |
| `runtime.json` | Upstream package, version, registry tarball integrity, source revision and license; the customization name and version; a sha256 for every file; the composed layout | generated |

**Supported set: `bmad-build`**, both its normal route (plan → implement →
review → present) and its oneshot route. That is the GC development/build
path: minions run it, and its built-in review is what minion-commissioned
reviewers execute. Its dependency closure is bundled: the renderer and its
one import, every step, template, rubric and reviewer prompt the workflow
references. The skill also mentions `bmad-advanced-elicitation`,
`bmad-party-mode` and `bmad-walkthrough` as optional, human-facing next
steps; they are not part of the build path and are not bundled
(`runtime.json` lists them under `optional_skill_references`, and a test fails
if the workflow starts depending on anything else).

The GC layer adds:

- `scripts/gc_render.py`: runs the unchanged upstream renderer with GC's
  configuration and customization layers (below), so no repo-local
  `_bmad/scripts` install is needed.
- `skills/bmad-build/SKILL.md`: the upstream launcher with one line changed,
  pointing at `gc_render.py`.
- `customize/bmad-build.toml`: a supported customization override (keyed
  `workflow.review_layers` and `workflow.oneshot_review_layers`) that
  replaces the Blind Hunter reviewer of both routes. Upstream requires that
  reviewer to find at least `min(floor(sqrt(kB) + 1), 10)` issues and forbids
  an empty list. GC keeps the same independent, context-free reviewer without
  a quota. A clean change may get no actionable findings
  (`No actionable findings.`). No tool-call or round ceiling replaces it, and
  the Edge Case Hunter and Verification Gap layers are unchanged.
- `config/defaults.toml`: the default configuration for the bundled skills.
  These are the values a default upstream install writes.
- `.claude-plugin/plugin.json`: lets Claude Code load the runtime as a plugin.
- `NOTICE.md`: attribution, license and trademark notice. The upstream
  `LICENSE` ships unchanged beside it.

The build runs `node dist/cli/bmad-runtime.js verify .`. It fails on any
missing, extra, symlinked or changed file. At run time GC refuses a broken
bundle the same way, and never borrows a BMAD install from somewhere else.

## Project state stays in the project

| Path | Owner | Notes |
|------|-------|-------|
| `_bmad/custom/config.toml` | project (team) | commit it to share settings with fresh worktrees |
| `_bmad/custom/config.user.toml` | project (personal) | ignored by `_bmad/custom/.gitignore`, so it applies to this checkout only; job lanes do not see it |
| `_bmad/custom/<skill>.toml` / `<skill>.user.toml` | project | customization overrides (team / personal) |
| `_bmad-output/` (default) | project | specs, stories, evidence, other generated work; never moved or rewritten |
| `_bmad/render/` | derived | rendered workflow snapshots; ignores itself (`.gitignore` = `*`) |
| `_bmad/custom/legacy-install/` | project | verbatim installer answers kept by the retirement commands; not read |

Put every setting a GC job must honor in the committed team file:
personal files never reach a fresh job lane.

**Configuration precedence** (later wins):

1. `<runtime>/config/defaults.toml`
2. `_bmad/custom/config.toml`
3. `_bmad/custom/config.user.toml`

**Customization precedence** for skill `<s>` (later wins; review layers merge
by `id`):

1. `<runtime>/skills/<s>/customize.toml` (upstream defaults)
2. `<runtime>/customize/<s>.toml` (GC layer)
3. `_bmad/custom/<s>.toml`
4. `_bmad/custom/<s>.user.toml`

The runtime does not read a legacy install's answer files (`_bmad/config.toml`,
`_bmad/config.user.toml`). It refuses to render, and names the setting, if
one of them holds a value for a setting it uses that differs from the
effective value. A setting is never dropped silently. The retirement commands
below re-home those answers into `_bmad/custom/`.

Rendering writes only into the project checkout it renders for. It writes
`_bmad/render/` of that worktree and creates configured output folders that
resolve inside the project on demand, so a fresh worktree needs nothing
provisioned. It never writes into the runtime or another project. It
refuses to read or write project state through a symlink: `_bmad`,
`_bmad/custom` and its settings files, and anything under
`_bmad/render/<skill>`.

**Provisioning.** The setup wizard's BMAD step (`provision`, the default for
each selected repo; `skip` leaves a repo untouched) creates only what is
missing: `_bmad/custom/` with its `.gitignore`, `_bmad/render/` with its
`.gitignore`, and the configured output folders that resolve inside the repo.
It never modifies an existing file or directory. It never touches a legacy
install or unrelated skills, and never runs the upstream installer.

Before creating anything, it checks the project the way the renderer will
read it, so it never reports ready for a repo whose first build would stop:

- every `_bmad/custom/*.toml` parses;
- the settings the bundled skills read are strings;
- no legacy installer answer differs from the effective value;
- a kept `_bmad/render/.gitignore` still ignores snapshots;
- no target is a symlink or the wrong kind of entry.

Last, it runs every bundled skill's own launcher against the repo, exactly
as a build would. A `HALT` is a deterministic refusal, and the entries this
run created are removed again.

The headless answers values `install` and `reuse` were retired with the
repo-local installer and fail loud.

## How a job binds to a runtime

- The runtime is never run from the package tree, because `install.sh --update`
  replaces that in place. The verified bundle is composed into
  `<data_dir>/bmad-runtime/<package>-<version>-<customization>-<n>-<content sha256 prefix>/`
  with read-only files. The directory name is derived from the content, so
  every name holds exactly one set of bytes.
- When a minion (the role that runs build workflows) starts in a job lane,
  GC records the runtime in the lane's private git dir
  (`$(git rev-parse --git-dir)/gru-command/bmad-runtime.json`). Every later
  session in that lane uses the recorded runtime, including resumes, fix
  rounds and restarts. When a GC update ships runtime B, a job started on A
  keeps A, and a new lane binds to B.
- A recorded runtime that is missing or modified fails the spawn loudly. GC
  restores it only when the current build ships the very same bytes.
- A cwd that is not a linked worktree uses the current runtime unrecorded.
- A supervised crash restart resumes a minion in its job's live worktree, so
  it keeps the lane's recorded runtime. A spawn with no project cwd at all
  gets no runtime, and the service logs a warning. A restart whose lane is
  gone is such a spawn.
- Sessions receive the runtime beside the project's own skills. pi gets the
  bundled skills first, so a repo-local or global `bmad-build` can't shadow
  them. Claude Code loads the runtime with `--plugin-dir`, which lists the
  skill as `gru-command-bmad:bmad-build`. The session's system prompt names
  the bound runtime id, its content hash and its location. Review sessions
  (Perkins) never get it.
- The bmad-review fallback gate is unaffected. It reads an installed global
  `bmad-review` skill, which was never repo-local. That skill falls back to
  its own defaults when a repo has no `_bmad/scripts`.

## Upgrading the bundled runtime (maintainers)

Upgrades are deliberate and ship as a tested dependency in a GC release.
Nothing downloads skill instructions during a job.

```sh
mkdir -p /tmp/bmad-upgrade && cd /tmp/bmad-upgrade
npm view bmad-method@<version> dist.integrity gitHead     # record both
npm pack bmad-method@<version>
cd <gru-command checkout> && npm run build
node dist/cli/bmad-runtime.js vendor --tarball /tmp/bmad-upgrade/bmad-method-<version>.tgz \
  --version <version> --integrity <sha512-…> --git-head <sha> \
  [--customization-version <n>] .
git diff -- resources/bmad-runtime
```

`vendor` refuses a tarball whose sha512 differs from `--integrity`, so the
recorded provenance is checked before any upstream byte is used.

Then review the diff:

- Read the upstream changes to `bmad-build`.
- Confirm the GC launcher overlay still differs from the new upstream
  `SKILL.md` by exactly the renderer line.
- Confirm the review-layer ids and the `customize.toml` merge rules still
  match the GC override.
- Confirm nothing new is referenced outside the bundle.

The tests in `test/bmad-runtime.test.ts` check all four. Bump
`--customization-version` whenever the `gc/` layer changes. After editing a
`gc/` file alone, regenerate hashes with
`node dist/cli/bmad-runtime.js manifest . --customization-version <n>`.
Running jobs keep their materialized runtime. Old directories under
`<data_dir>/bmad-runtime/` can be deleted by hand once no lane's
`bmad-runtime.json` names them.

## Retiring a repo-local install (owner-run)

GC never removes an existing installation itself. These commands retire the
old repo-local `_bmad` framework and its skill bindings from **one explicitly
selected repository**, for the layout the previous GC onboarding and
`bmad-method` 6.x installs created. Run them only after the bundled runtime
works for you, and never while a GC job still runs in one of the repo's lanes
(the preview lists them).

Each step is one copy-paste block for `sh`/`bash`/`zsh`. Everything that
moves goes to `$BACKUP`, so it can be restored. Nothing is deleted.

**What stays:**

- `_bmad-output/` and `_bmad/custom/`
- every file inside the old module and script directories that is not in
  the installer's hash record (notes you kept there, edited files)
- your settings
- every unrelated or modified skill, because only bindings whose every file
  matches the installer's own hash record (`_bmad/_config/files-manifest.csv`)
  move
- user setup commands in `.gru-command/worktree.toml`
- all other project files

**1. Choose the repository** (edit the first two lines):

```sh
# bmad-retire:vars
REPO="$HOME/code/your-repo"     # the ONE repository to retire (absolute path)
GC="$HOME/code/gru-command"     # the Gru Command install your service runs from
BACKUP="$HOME/.gru-command/bmad-legacy-backups/$(basename "$REPO")-$(date +%Y%m%dT%H%M%S)"
```

**2. Preview.** This step is read-only for the repository. It writes the plan
to `$BACKUP/plan.json` and prints what each later step will do:

```sh
# bmad-retire:preview
mkdir -p "$BACKUP" && python3 -I - "$REPO" "$BACKUP" "$GC" <<'PY'
import sys
if sys.version_info < (3, 11):
    sys.exit("STOP: these commands need python3 >= 3.11 (tomllib)")
import csv, hashlib, json, os, re, subprocess, tomllib
repo, backup, gc = (os.path.realpath(p) for p in sys.argv[1:4])
def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
top = git("rev-parse", "--show-toplevel")
if top.returncode != 0 or os.path.realpath(top.stdout.strip()) != repo:
    sys.exit(f"STOP: {repo} is not the root of a git repository")
if os.path.commonpath([repo, backup]) == repo:
    sys.exit("STOP: BACKUP must be outside the repository")
cfg = os.path.join(repo, "_bmad", "_config")
if not os.path.isfile(os.path.join(cfg, "manifest.yaml")):
    sys.exit("STOP: no repo-local BMAD install (_bmad/_config/manifest.yaml); nothing to retire")
for rel in ("_bmad", "_bmad/custom", "_bmad/custom/config.toml", "_bmad/custom/config.user.toml",
            "_bmad/config.toml", "_bmad/config.user.toml", "_bmad/_config", "_bmad/_config/manifest.yaml",
            "_bmad/_config/files-manifest.csv", "_bmad/_config/skill-manifest.csv", ".gru-command",
            ".gru-command/worktree.toml", ".gru-command/bmad-install.json", ".gru-command/bmad-bootstrap.mjs"):
    if os.path.islink(os.path.join(repo, rel)):
        sys.exit(f"STOP: {rel} is a symlink; these commands read and write only inside the repository")
for name in ("files-manifest.csv", "skill-manifest.csv"):
    if not os.path.isfile(os.path.join(cfg, name)):
        sys.exit(f"STOP: _bmad/_config/{name} is missing; without the installer's own record nothing can be proven installer-owned")
def sha(rel):
    with open(os.path.join(repo, rel), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
def files_under(rel):
    root, out = os.path.join(repo, rel), []
    if os.path.islink(root) or not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        out += [os.path.relpath(os.path.join(dirpath, n), repo) for n in sorted(filenames)]
    return out
modules, section = [], None
for line in open(os.path.join(cfg, "manifest.yaml"), encoding="utf-8"):
    if re.match(r"^\S.*:\s*$", line):
        section = line.strip()[:-1]
    match = re.match(r"^\s*-\s+name:\s*['\"]?([A-Za-z0-9_-]+)", line)
    if section == "modules" and match:
        modules.append(match.group(1))
def read_csv(name):
    path = os.path.join(cfg, name)
    return list(csv.DictReader(open(path, encoding="utf-8"))) if os.path.isfile(path) else []
rows = read_csv("files-manifest.csv")
recorded = {row["path"]: row["hash"] for row in rows}
# Installer metadata, derived renders and answer files move whole; module and
# script files move only when they match the installer's own hash record.
whole = [f"_bmad/{n}" for n in ("_config", "render", "config.toml", "config.user.toml")
         if os.path.lexists(os.path.join(repo, "_bmad", n))]
module_dirs = [n for n in ("scripts", *modules)
               if os.path.isdir(os.path.join(repo, "_bmad", n)) and not os.path.islink(os.path.join(repo, "_bmad", n))]
installer_files, leftovers = [], []
for n in module_dirs:
    for f in files_under(f"_bmad/{n}"):
        path = os.path.join(repo, f)
        if not os.path.islink(path) and recorded.get(f[len("_bmad/"):]) == sha(f):
            installer_files.append(f)
        else:
            leftovers.append(f)
    for dirpath, dirnames, filenames in os.walk(os.path.join(repo, "_bmad", n)):
        leftovers += [os.path.relpath(os.path.join(dirpath, d), repo) for d in dirnames if os.path.islink(os.path.join(dirpath, d))]
framework = whole + installer_files
known = {"_config", "render", "config.toml", "config.user.toml", "custom", *module_dirs}
unrecognized = sorted(f"_bmad/{n}" for n in os.listdir(os.path.join(repo, "_bmad")) if n not in known)
ids = {row["canonicalId"] for row in read_csv("skill-manifest.csv")}
def gc_owned_json(rel):
    try:
        return json.load(open(os.path.join(repo, rel), encoding="utf-8")).get("managed_by") == "gru-command"
    except (OSError, ValueError, AttributeError):
        return False
record = json.load(open(os.path.join(repo, ".gru-command", "bmad-install.json"))) \
    if gc_owned_json(".gru-command/bmad-install.json") else {}
patched = "qualify-bmm-gds-short-config-tokens-v1" in record.get("compatibility_patches", [])
def unpatched(data):
    text = data.decode("utf-8", "replace")
    for key in ("planning_artifacts", "implementation_artifacts", "project_knowledge"):
        for module in ("bmm", "gds"):
            text = text.replace("{{config.modules.%s.%s}}" % (module, key), "{{.%s}}" % key)
    return text.encode("utf-8")
def proven(rel, name):
    root = os.path.join(repo, rel)
    if name not in ids or os.path.islink(root) or not os.path.isfile(os.path.join(root, "SKILL.md")):
        return False
    for dirpath, dirnames, filenames in os.walk(root):
        if any(os.path.islink(os.path.join(dirpath, n)) for n in dirnames + filenames):
            return False
    for f in files_under(rel):
        if os.path.islink(os.path.join(repo, f)):
            return False
        data = open(os.path.join(repo, f), "rb").read()
        hashes = {hashlib.sha256(data).hexdigest()}
        if patched:
            hashes.add(hashlib.sha256(unpatched(data)).hexdigest())
        tail = "/" + name + "/" + os.path.relpath(f, rel).replace(os.sep, "/")
        if not any(("/" + row["path"]).endswith(tail) and row["hash"] in hashes for row in rows):
            return False
    return True
bindings, unproven = [], []
for root in (".agents/skills", ".claude/skills"):
    if os.path.islink(os.path.join(repo, root)) or not os.path.isdir(os.path.join(repo, root)):
        continue
    for name in sorted(os.listdir(os.path.join(repo, root))):
        if name in ids:
            (bindings if proven(f"{root}/{name}", name) else unproven).append(f"{root}/{name}")
gc_files = [rel for rel in (".gru-command/bmad-install.json",) if gc_owned_json(rel)]
boot = os.path.join(repo, ".gru-command", "bmad-bootstrap.mjs")
if os.path.isfile(boot) and "// Managed by Gru Command BMAD bootstrap v1" in open(boot, encoding="utf-8").read():
    gc_files.append(".gru-command/bmad-bootstrap.mjs")
def has_block(path, start, end):
    if not os.path.isfile(path):
        return False
    lines = open(path, encoding="utf-8").read().splitlines()
    return start in lines and end in lines and lines.index(start) < lines.index(end)
manifest_block = has_block(os.path.join(repo, ".gru-command", "worktree.toml"),
                           "# BEGIN GRU COMMAND BMAD BOOTSTRAP", "# END GRU COMMAND BMAD BOOTSTRAP")
exclude = git("rev-parse", "--git-path", "info/exclude").stdout.strip()
exclude = os.path.join(repo, exclude) if exclude and not os.path.isabs(exclude) else exclude
exclude_block = has_block(exclude, "# BEGIN GRU COMMAND BMAD GENERATED", "# END GRU COMMAND BMAD GENERATED")
source = git("config", "--local", "--get", "gru-command.bmad-source").stdout.strip() or None
defaults = tomllib.load(open(os.path.join(gc, "resources", "bmad-runtime", "gc", "config", "defaults.toml"), "rb"))
def flat(data):
    out = {f"core.{k}": v for k, v in data.get("core", {}).items() if not isinstance(v, (dict, list))}
    out.update({f"modules.bmm.{k}": v for k, v in data.get("modules", {}).get("bmm", {}).items()
                if not isinstance(v, (dict, list))})
    return out
default_values = flat(defaults)
def legacy(name):
    path = os.path.join(repo, "_bmad", name)
    return flat(tomllib.load(open(path, "rb"))) if os.path.isfile(path) else {}
# Layered like the installer: team answers over GC defaults, personal over both.
legacy_team, legacy_personal = legacy("config.toml"), legacy("config.user.toml")
team_effective = {**default_values, **legacy_team}
transfer = {
    "team": {k: v for k, v in legacy_team.items() if default_values.get(k) != v},
    "personal": {k: v for k, v in legacy_personal.items() if team_effective.get(k) != v},
}
blocked = []
for scope, name in (("team", "config.toml"), ("personal", "config.user.toml")):
    path = os.path.join(repo, "_bmad", "custom", name)
    custom = tomllib.load(open(path, "rb")) if os.path.isfile(path) else {}
    present = flat(custom)
    transfer[scope] = {k: v for k, v in transfer[scope].items() if present.get(k) != v}
    if transfer[scope] and custom:
        blocked.append(f"_bmad/custom/{name}: add {json.dumps(transfer[scope], ensure_ascii=False)}")
legacy_answers = [n for n in ("config.toml", "config.user.toml") if os.path.isfile(os.path.join(repo, "_bmad", n))]
moving = framework + bindings + gc_files
tracked = git("ls-files", "-z").stdout.split("\0")
protected = {}
for rel in (*files_under("_bmad-output"), *files_under("_bmad/custom"), *leftovers,
            *(f for root in (".agents/skills", ".claude/skills") for f in files_under(root)),
            *(t for t in tracked if t)):
    if any(rel == m or rel.startswith(m + "/") for m in moving) or rel == ".gru-command/worktree.toml":
        continue
    if os.path.isfile(os.path.join(repo, rel)) and not os.path.islink(os.path.join(repo, rel)):
        protected[rel] = sha(rel)
lanes = []
for line in git("worktree", "list", "--porcelain").stdout.splitlines():
    if line.startswith("worktree ") and os.path.realpath(line[9:]) != repo:
        lanes.append(line[9:])
proofs = {f: sha(f) for f in installer_files}
proofs.update({f: sha(f) for b in bindings for f in files_under(b)})
plan = {"repo": repo, "framework": framework, "bindings": bindings, "unproven_bindings": unproven, "proofs": proofs,
        "unrecognized": unrecognized, "leftovers": leftovers, "module_dirs": module_dirs,
        "gc_files": gc_files, "manifest_block": manifest_block,
        "exclude": exclude, "exclude_block": exclude_block, "git_source": source,
        "transfer": transfer, "transfer_blocked": blocked, "legacy_answers": legacy_answers,
        "custom_existed": os.path.isdir(os.path.join(repo, "_bmad", "custom")), "protected": protected}
with open(os.path.join(backup, "plan.json"), "w", encoding="utf-8") as f:
    json.dump(plan, f, indent=2)
print(f"Plan for {repo} (saved to {backup}/plan.json)")
print("  move aside (framework):", ", ".join(whole) or "nothing",
      f"+ {len(installer_files)} installer-recorded files under _bmad/{{{','.join(module_dirs)}}}")
print(f"  move aside (proven BMAD skill bindings): {len(bindings)}")
print("  GC-owned bootstrap references:", ", ".join(gc_files + (["worktree.toml block"] if manifest_block else [])
      + (["local exclude block"] if exclude_block else []) + (["git config gru-command.bmad-source"] if source else [])) or "none")
print("  re-home settings:", json.dumps(transfer, ensure_ascii=False) if any(transfer.values()) else "none pending")
if legacy_answers:
    print("  keep installer answers for reference in _bmad/custom/legacy-install/ (not read by the runtime):", ", ".join(legacy_answers))
print("  keep untouched:", "_bmad/custom/, _bmad-output/,", len(protected), "protected files")
for rel in unproven:
    print(f"  LEFT IN PLACE (not provably installer-owned): {rel}")
for rel in unrecognized:
    print(f"  LEFT IN PLACE (not part of the supported layout): {rel}")
for rel in leftovers:
    print(f"  LEFT IN PLACE (not in the installer's hash record): {rel}")
for item in blocked:
    print(f"  STOP before step 3: {item} by hand (the file already has settings), then re-run this preview")
ignored = git("check-ignore", "-v", "_bmad/custom/config.toml").stdout.strip()
if ignored:
    print(f"  NOTE: _bmad/custom/config.toml is git-ignored by `{ignored}`; team settings stay local until you change that rule")
for lane in lanes:
    print(f"  LANE: {lane}  -- do not continue while a GC job still runs here")
PY
```

**3. Back up and re-home settings.** This copies everything the next step
edits in place into `$BACKUP/copy/`. It then writes legacy answers that
differ from the GC defaults into `_bmad/custom/config.toml` (team) and
`_bmad/custom/config.user.toml` (personal). Only `[core]` and
`[modules.bmm]` move, because those are the sections the bundled runtime
uses; answers already there are skipped. It also keeps both legacy answer
files verbatim, including the settings of modules GC does not bundle, in
`_bmad/custom/legacy-install/`. The runtime does not read that copy; it is
there for reference.

```sh
# bmad-retire:backup
python3 -I - "$REPO" "$BACKUP" <<'PY'
import datetime, json, os, shutil, sys, tomllib
repo, backup = (os.path.realpath(p) for p in sys.argv[1:3])
plan = json.load(open(os.path.join(backup, "plan.json"), encoding="utf-8"))
if plan["repo"] != repo:
    sys.exit("STOP: the plan in BACKUP is for a different repository")
if plan["transfer_blocked"]:
    sys.exit("STOP: merge these settings by hand first: " + ", ".join(plan["transfer_blocked"]))
copy = os.path.join(backup, "copy")
if os.path.exists(copy):
    sys.exit(f"STOP: {copy} already exists; use a fresh BACKUP")
os.makedirs(copy)
if not plan["custom_existed"]:
    open(os.path.join(copy, "custom-was-absent"), "w").close()
for rel in ("_bmad/custom", ".gru-command/worktree.toml"):
    src, dst = os.path.join(repo, rel), os.path.join(copy, rel)
    if os.path.isdir(src) and not os.path.islink(src):
        shutil.copytree(src, dst, symlinks=True)
    elif os.path.isfile(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
if plan["exclude"] and os.path.isfile(plan["exclude"]):
    shutil.copy2(plan["exclude"], os.path.join(copy, "info-exclude"))
def value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return json.dumps(str(v), ensure_ascii=False)
for scope, name in (("team", "config.toml"), ("personal", "config.user.toml")):
    values = plan["transfer"][scope]
    if not values:
        continue
    path = os.path.join(repo, "_bmad", "custom", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing = open(path, encoding="utf-8").read() if os.path.isfile(path) else ""
    if existing and tomllib.loads(existing):
        sys.exit(f"STOP: {path} gained settings since the preview; re-run the preview")
    lines = ["" if not existing or existing.endswith("\n") else "\n",
             f"\n# Re-homed from the retired repo-local BMAD install ({datetime.date.today()}).\n"]
    for table in ("core", "modules.bmm"):
        keys = sorted(k for k in values if k.rsplit(".", 1)[0] == table)
        if keys:
            lines.append(f"[{table}]\n" + "".join(f"{k.rsplit('.', 1)[1]} = {value(values[k])}\n" for k in keys))
    text = existing + "".join(lines)
    parsed = tomllib.loads(text)
    for key, expected in values.items():
        found = parsed
        for part in key.split("."):
            found = found[part]
        assert found == expected, key
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"re-homed {len(values)} setting(s) into {path}")
for name in plan["legacy_answers"]:
    dst = os.path.join(repo, "_bmad", "custom", "legacy-install", name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        sys.exit(f"STOP: {dst} already exists")
    shutil.copy2(os.path.join(repo, "_bmad", name), dst)
if plan["legacy_answers"]:
    print("kept the installer answers in _bmad/custom/legacy-install/ (the runtime does not read them)")
print(f"backup copies in {copy}")
PY
```

**4. Move the retired install aside** and drop the GC-owned bootstrap
references, so a later worktree cannot reinstall the old framework:

```sh
# bmad-retire:move
python3 -I - "$REPO" "$BACKUP" <<'PY'
import hashlib, json, os, shutil, subprocess, sys
repo, backup = (os.path.realpath(p) for p in sys.argv[1:3])
plan = json.load(open(os.path.join(backup, "plan.json"), encoding="utf-8"))
if plan["repo"] != repo or not os.path.isdir(os.path.join(backup, "copy")):
    sys.exit("STOP: run the preview and backup steps for this repository first")
def drop_block(path, start, end):
    text = open(path, encoding="utf-8", newline="").read()
    lines = text.splitlines(keepends=True)
    first = next(i for i, l in enumerate(lines) if l.rstrip("\r\n") == start)
    last = next(i for i, l in enumerate(lines) if l.rstrip("\r\n") == end and i > first)
    before, after = lines[:first], lines[last + 1:]
    if after and after[0].strip() == "" and (not before or before[-1].strip() == ""):
        after = after[1:]
    if before and before[-1].strip() == "" and not after:
        before = before[:-1]
    return "".join(before + after)
# Nothing moves unless every proven file is still exactly what the preview saw.
def through_link(rel):
    parts = rel.split("/")
    return any(os.path.islink(os.path.join(repo, *parts[:i])) for i in range(1, len(parts) + 1))
changed = [rel for rel, digest in plan["proofs"].items()
           if through_link(rel) or not os.path.isfile(os.path.join(repo, rel))
           or hashlib.sha256(open(os.path.join(repo, rel), "rb").read()).hexdigest() != digest]
for b in plan["bindings"]:
    for dirpath, dirnames, filenames in os.walk(os.path.join(repo, b)):
        changed += [os.path.relpath(os.path.join(dirpath, n), repo) for n in filenames + dirnames
                    if os.path.islink(os.path.join(dirpath, n))
                    or (n in filenames and os.path.relpath(os.path.join(dirpath, n), repo) not in plan["proofs"])]
if changed:
    sys.exit("STOP: changed since the preview, re-run it: " + ", ".join(sorted(set(changed))))
# Work out both edits before anything moves, so a surprise stops cleanly.
manifest = os.path.join(repo, ".gru-command", "worktree.toml")
manifest_rest = drop_block(manifest, "# BEGIN GRU COMMAND BMAD BOOTSTRAP", "# END GRU COMMAND BMAD BOOTSTRAP") \
    if plan["manifest_block"] else None
exclude_rest = drop_block(plan["exclude"], "# BEGIN GRU COMMAND BMAD GENERATED", "# END GRU COMMAND BMAD GENERATED") \
    if plan["exclude_block"] else None
moved = os.path.join(backup, "moved")
for rel in plan["framework"] + plan["bindings"] + plan["gc_files"]:
    src, dst = os.path.join(repo, rel), os.path.join(moved, rel)
    if not os.path.lexists(src):
        continue
    if os.path.lexists(dst):
        sys.exit(f"STOP: {dst} already exists")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(src, dst)
if manifest_rest is not None:
    if manifest_rest.strip():
        open(manifest, "w", encoding="utf-8", newline="").write(manifest_rest)
    else:
        os.makedirs(os.path.join(moved, ".gru-command"), exist_ok=True)
        shutil.move(manifest, os.path.join(moved, ".gru-command", "worktree.toml"))
if exclude_rest is not None:
    open(plan["exclude"], "w", encoding="utf-8", newline="").write(exclude_rest)
for n in plan["module_dirs"]:
    for dirpath, dirnames, filenames in os.walk(os.path.join(repo, "_bmad", n), topdown=False):
        if not os.listdir(dirpath):
            os.rmdir(dirpath)
if plan["git_source"]:
    subprocess.run(["git", "-C", repo, "config", "--local", "--unset", "gru-command.bmad-source"], check=True)
print(f"moved aside into {moved}")
PY
```

**5. Verify this checkout.** This checks that every protected file is
unchanged (re-homed settings files may only have grown). It then checks
that the retired checkout renders with the bundled runtime and no
repo-local install, and shows what to commit:

```sh
# bmad-retire:verify
if python3 -I - "$REPO" "$BACKUP" <<'PY'
import hashlib, json, os, sys
repo, backup = (os.path.realpath(p) for p in sys.argv[1:3])
plan = json.load(open(os.path.join(backup, "plan.json"), encoding="utf-8"))
copy = os.path.join(backup, "copy")
failed = []
for rel, digest in plan["protected"].items():
    path = os.path.join(repo, rel)
    if not os.path.isfile(path):
        failed.append(f"missing {rel}")
        continue
    data = open(path, "rb").read()
    if hashlib.sha256(data).hexdigest() == digest:
        continue
    original = os.path.join(copy, rel)
    grown = rel in ("_bmad/custom/config.toml", "_bmad/custom/config.user.toml") and \
        os.path.isfile(original) and data.startswith(open(original, "rb").read())
    if not grown:
        failed.append(f"changed {rel}")
if failed:
    sys.exit("FAILED: " + "; ".join(failed))
print(f"ok: {len(plan['protected'])} protected files unchanged")
PY
then
  node "$GC/dist/cli/bmad-runtime.js" check "$REPO" && git -C "$REPO" status --short
else
  false
fi
```

**6. Commit, then prove a fresh worktree.** Commit the resulting changes to
tracked files, for example the edited `.gru-command/worktree.toml` and the
removed bootstrap files. When fresh worktrees should share team settings,
commit `_bmad/custom/` too. Then check that a fresh worktree of the new
`HEAD` (what the next GC lane checks out) renders with the bundled runtime:

```sh
# bmad-retire:fresh-worktree
git -C "$REPO" worktree add --detach "$BACKUP/verify-worktree" HEAD >/dev/null &&
  { node "$GC/dist/cli/bmad-runtime.js" check "$BACKUP/verify-worktree"; rc=$?;
    git -C "$REPO" worktree remove --force "$BACKUP/verify-worktree"; test "$rc" -eq 0; }
```

Until you commit, the retired bootstrap block is already inert, because the
`gru-command.bmad-source` setting it depends on was removed in step 4.

**Undo** (restores everything the steps moved or edited):

```sh
# bmad-retire:restore
python3 -I - "$REPO" "$BACKUP" <<'PY'
import json, os, shutil, subprocess, sys
repo, backup = (os.path.realpath(p) for p in sys.argv[1:3])
plan = json.load(open(os.path.join(backup, "plan.json"), encoding="utf-8"))
moved, copy = os.path.join(backup, "moved"), os.path.join(backup, "copy")
# Undo restores _bmad/custom from the backup; never drop settings added since.
custom = os.path.join(repo, "_bmad", "custom")
newer = []
for dirpath, dirnames, filenames in os.walk(custom):
    for name in filenames:
        rel = os.path.relpath(os.path.join(dirpath, name), repo)
        made_by_retirement = rel.startswith("_bmad/custom/legacy-install/") or \
            rel in ("_bmad/custom/config.toml", "_bmad/custom/config.user.toml")
        if not made_by_retirement and not os.path.exists(os.path.join(copy, rel)):
            newer.append(rel)
if newer:
    sys.exit("STOP: added after the backup, move them out of _bmad/custom first: " + ", ".join(sorted(newer)))
for dirpath, dirnames, filenames in os.walk(moved, topdown=True):
    rel = os.path.relpath(dirpath, moved)
    for name in list(dirnames) + filenames:
        item = os.path.normpath(os.path.join(rel, name))
        if item in plan["framework"] + plan["bindings"] + plan["gc_files"] + [".gru-command/worktree.toml"]:
            dst = os.path.join(repo, item)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.lexists(dst):
                os.remove(dst) if not os.path.isdir(dst) else shutil.rmtree(dst)
            shutil.move(os.path.join(dirpath, name), dst)
            if name in dirnames:
                dirnames.remove(name)
for rel in ("_bmad/custom", ".gru-command/worktree.toml"):
    src, dst = os.path.join(copy, rel), os.path.join(repo, rel)
    if os.path.isdir(src):
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst, symlinks=True)
    elif os.path.isfile(src):
        shutil.copy2(src, dst)
if os.path.isfile(os.path.join(copy, "custom-was-absent")):
    shutil.rmtree(os.path.join(repo, "_bmad", "custom"), ignore_errors=True)
if os.path.isfile(os.path.join(copy, "info-exclude")):
    shutil.copy2(os.path.join(copy, "info-exclude"), plan["exclude"])
if plan["git_source"]:
    subprocess.run(["git", "-C", repo, "config", "--local", "gru-command.bmad-source", plan["git_source"]], check=True)
print("restored from", backup)
PY
```

## License and notices

The bundled upstream files are © BMad Code, LLC, MIT-licensed. The license
text ships unchanged as `resources/bmad-runtime/upstream/LICENSE` and, in
every materialized runtime, as `LICENSE`. Attribution, the upstream trademark
notice and a description of the GC changes are in
`resources/bmad-runtime/gc/NOTICE.md`.
