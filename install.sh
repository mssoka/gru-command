#!/usr/bin/env bash
# Gru Command — installer (EPICS E7 story 3 + E9 story 1; SPEC rulings 5/10/14).
#
# The GitHub ONE-LINE INSTALLER entry:
#   curl -fsSL https://raw.githubusercontent.com/mssoka/gru-command/main/install.sh | bash
# (no clone present → clone → deps → build → setup wizard → first-boot smoke)
#
# Usage:
#   ./install.sh                     fresh install, or safe update when an
#                                    instance config already exists
#   ./install.sh --update            pull --ff-only + deps + builds + restart
#                                    only an owned installed service
#   ./install.sh --no-interact       fresh setup with documented defaults
#   ./install.sh --answers '<json>'  fresh non-interactive setup overrides;
#                                    secrets are forbidden in answers
#   ./install.sh --force             allow wizard/config replacement with backup
#   ./install.sh --service           register + start the OS service only
#                                    (the E7 path; also how the wizard
#                                    registers the service — one mechanism)
#   ./install.sh --print             render the unit to stdout; change nothing
#   ./install.sh --uninstall         stop the service and remove the unit
#
# Everything is resolved ABSOLUTELY at install time (repo root, node
# binary, instance dir) — service managers do not inherit your shell
# environment. No personal or project specifics belong in the templates.
#
# Test/install seams (also handy for real users):
#   GRU_COMMAND_ORIGIN   clone URL when piped (default: the GitHub repo)
#   GRU_COMMAND_TARGET   clone destination    (default: ~/gru-command)

set -euo pipefail

LABEL="com.gru-command.service"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
INSTANCE_DIR="${GRU_COMMAND_HOME:-$HOME/.gru-command}"
CLONE_ORIGIN="${GRU_COMMAND_ORIGIN:-https://github.com/mssoka/gru-command.git}"
CLONE_TARGET="${GRU_COMMAND_TARGET:-$HOME/gru-command}"
MODE="setup"
ANSWERS=""
ANSWERS_SET=0
NO_INTERACT=0
FORCE=0
UPDATE_REQUESTED=0
LAUNCHCTL_BIN="${GRU_COMMAND_LAUNCHCTL:-launchctl}"
SYSTEMCTL_BIN="${GRU_COMMAND_SYSTEMCTL:-systemctl}"

err() { echo "install.sh: $*" >&2; }
# Secrets approved for wizard persistence stay in this trusted shell/wizard;
# unrelated package, VCS, build, and service-manager children never inherit it.
run_sanitized() { env -u OPENROUTER_API_KEY "$@"; }
# The range MUST cover the whole header block through the seam lines
# (GRU_COMMAND_ORIGIN / GRU_COMMAND_TARGET) — --help shows all of it.
usage() {
  sed -n '2,31p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) MODE="print" ; shift ;;
    --uninstall) MODE="uninstall" ; shift ;;
    --service) MODE="service" ; shift ;;
    --update) UPDATE_REQUESTED=1; shift ;;
    --no-interact) NO_INTERACT=1; shift ;;
    --force) FORCE=1; shift ;;
    --answers)
      [[ $# -ge 2 ]] || { err "--answers requires a JSON argument"; exit 2; }
      ANSWERS="$2"; ANSWERS_SET=1; NO_INTERACT=1; shift 2 ;;
    --answers=*)
      ANSWERS="${1#--answers=}"; ANSWERS_SET=1; NO_INTERACT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown flag: $1 (valid: --update, --no-interact, --answers <json>, --force, --service, --print, --uninstall, -h|--help)"; exit 2 ;;
  esac
done

# Contradicting combos fail loud instead of resolving silently: --answers
# is a SETUP-mode argument; pairing it with another mode drops one of them.
if [[ "$ANSWERS_SET" -eq 1 && "$MODE" != "setup" ]]; then
  err "--answers is only valid with setup mode, but mode is --$MODE — pass --answers alone (setup is the default)"
  exit 2
fi
if [[ "$UPDATE_REQUESTED" -eq 1 && ( "$ANSWERS_SET" -eq 1 || "$FORCE" -eq 1 ) ]]; then
  err "--update preserves config and cannot be combined with --answers or --force"
  exit 2
fi
if [[ "$MODE" != "setup" && ( "$NO_INTERACT" -eq 1 || "$FORCE" -eq 1 || "$UPDATE_REQUESTED" -eq 1 ) ]]; then
  err "--no-interact, --force, and --update are setup lifecycle flags"
  exit 2
fi
# An explicitly-empty --answers must not silently flip to interactive mode
# (Perkins r2 note) — the flag was GIVEN; an empty JSON object is '{}'.
if [[ "$ANSWERS_SET" -eq 1 && -z "$ANSWERS" ]]; then
  err "--answers was given an empty value — for full defaults pass --answers '{}'"
  exit 2
fi

# Resolve node to its REAL path: version managers (fnm/nvm/asdf) put
# ephemeral per-shell symlinks on PATH — a service unit pointing at one
# breaks on the next shell. The resolved install path is stable.
NODE_BIN="$(command -v node || true)"
if [[ -n "$NODE_BIN" ]]; then
  resolved="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
  [[ -x "$resolved" ]] && NODE_BIN="$resolved"
fi

if [[ -z "$NODE_BIN" ]]; then
  err "node was not found on PATH — install Node.js >= 22.19 first (https://nodejs.org)"
  exit 1
fi

node_ok() {
  "$NODE_BIN" -e 'const [M,m]=process.versions.node.split(".").map(Number);
    if (M < 22 || (M === 22 && m < 19)) process.exit(1)' 2>/dev/null
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

OS="$(detect_os)"
if [[ "$OS" == "unsupported" && "$MODE" != "uninstall" ]]; then
  err "unsupported platform: $(uname -s) — launchd (macOS) and systemd (Linux) units ship in install/"
  exit 1
fi

# ---------------------------------------------------------------------------
# Unit rendering — escape placeholder values for the unit syntax (paths
# with spaces survive; systemd accepts quoted ExecStart, plists need none).
# ---------------------------------------------------------------------------
# Escape sed replacement metacharacters (backslash, ampersand, and the
# delimiter) so arbitrary install paths render verbatim. Newlines are
# rejected by the caller — they cannot render into unit fields.
esc_for_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

render_unit() {
  local template="$1"
  local node="$2" repo="$3" home="$4"
  # Multi-line paths cannot render into single-line unit fields.
  for value in "$node" "$repo" "$home"; do
    if [[ "$value" == *$'\n'* ]]; then
      err "path contains a newline which the unit renderer cannot escape: $value"
      exit 1
    fi
  done
  # systemd ExecStart quotes args containing spaces; launchd needs none.
  local node_arg=""
  node_arg="$(esc_for_sed "$node")"
  local repo_arg=""
  repo_arg="$(esc_for_sed "$repo")"
  local home_arg=""
  home_arg="$(esc_for_sed "$home")"
  if [[ "$template" == *.service.template ]]; then
    [[ "$node" == *" "* ]] && node_arg="\"$node_arg\""
    [[ "$repo" == *" "* ]] && repo_arg="\"$repo_arg\""
    [[ "$home" == *" "* ]] && home_arg="\"$home_arg\""
  fi
  # The launchd unit carries the INSTALL-TIME PATH so runtime CLIs the
  # adapters spawn (resolved via PATH, possibly under a version manager
  # like fnm/nvm) stay findable outside any shell.
  local path_value=""
  path_value="$(esc_for_sed "$PATH:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin")"
  sed -e "s|{{NODE}}|$node_arg|g" \
      -e "s|{{REPO_ROOT}}|$repo_arg|g" \
      -e "s|{{GRU_COMMAND_HOME}}|$home_arg|g" \
      -e "s|{{PATH}}|$path_value|g" "$template"
}

verify_unit() {
  local rendered="$1" target_file="$2"
  if [[ "$target_file" == *.plist ]]; then
    if command -v plutil >/dev/null 2>&1; then
      plutil -lint "$rendered" >/dev/null
    fi
  else
    if command -v systemd-analyze >/dev/null 2>&1; then
      # Non-fatal on older systemd-analyze without user-unit support.
      systemd-analyze verify "$rendered" >/dev/null 2>&1 || true
    fi
  fi
}

# ---------------------------------------------------------------------------
# Platform installers (E7 — reached via --service, and by the wizard's
# optional service-registration step). Existing unit names are shared public
# names, so path ownership is proven before overwrite/restart.
# ---------------------------------------------------------------------------
service_target() {
  case "$OS" in
    darwin) printf '%s\n' "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
    linux) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/gru-command.service" ;;
  esac
}

service_ownership() {
  local target expected expected_env actual_exec expected_program rendered arg_count executable program instance managed
  target="$(service_target)"
  if [[ ! -f "$target" ]]; then
    if [[ "$OS" == "linux" && -d "$target.d" ]]; then echo "foreign"; else echo "absent"; fi
    return
  fi
  case "$OS" in
    darwin)
      command -v plutil >/dev/null 2>&1 || { echo "foreign"; return; }
      managed="$(plutil -extract GruCommandManagedBy raw -o - "$target" 2>/dev/null || true)"
      arg_count="$(plutil -extract ProgramArguments raw -o - "$target" 2>/dev/null || true)"
      executable="$(plutil -extract ProgramArguments.0 raw -o - "$target" 2>/dev/null || true)"
      program="$(plutil -extract ProgramArguments.1 raw -o - "$target" 2>/dev/null || true)"
      instance="$(plutil -extract EnvironmentVariables.GRU_COMMAND_HOME raw -o - "$target" 2>/dev/null || true)"
      if [[ "$managed" == "gru-command-install-v2" && "$arg_count" == "2" && \
            "$executable" == /*/node && "$program" == "$REPO_ROOT/dist/main.js" && \
            "$instance" == "$INSTANCE_DIR" ]]; then
        echo "owned"
      else
        echo "foreign"
      fi
      ;;
    linux)
      if [[ -d "$target.d" ]]; then
        echo "foreign"
        return
      fi
      rendered="$(render_unit "$REPO_ROOT/install/systemd/gru-command.service.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR")"
      expected="$(printf '%s\n' "$rendered" | grep '^ExecStart=' || true)"
      expected_env="$(printf '%s\n' "$rendered" | grep '^Environment=GRU_COMMAND_HOME=' || true)"
      expected_program="${expected#* }"
      actual_exec="$(grep '^ExecStart=' "$target" || true)"
      actual_exec="${actual_exec% "$expected_program"}"
      if [[ -n "$expected" && -n "$expected_env" ]] && \
         [[ "$actual_exec" == ExecStart=*node || "$actual_exec" == ExecStart=*"node'" || "$actual_exec" == ExecStart=*'node"' ]] && \
         [[ "$(grep -Fxc 'X-GruCommandManagedBy=gru-command-install-v2' "$target" || true)" == "1" ]] && \
         [[ "$(grep -c '^ExecStart=' "$target" || true)" == "1" ]] && \
         [[ "$(grep -c '^Environment=GRU_COMMAND_HOME=' "$target" || true)" == "1" ]] && \
         grep -Fqx -- "${actual_exec} ${expected_program}" "$target" && grep -Fxq -- "$expected_env" "$target"; then
        echo "owned"
      else
        echo "foreign"
      fi
      ;;
  esac
}

assert_service_owned_or_absent() {
  local ownership
  ownership="$(service_ownership)"
  if [[ "$ownership" == "foreign" ]]; then
    err "refusing to overwrite unrelated service unit: $(service_target)"
    err "the installed unit does not target repo $REPO_ROOT and instance $INSTANCE_DIR"
    exit 1
  fi
}

install_launchd() {
  local target_dir="$HOME/Library/LaunchAgents"
  local target="$target_dir/$LABEL.plist"
  local rendered
  assert_service_owned_or_absent
  rendered="$(render_unit "$REPO_ROOT/install/launchd/$LABEL.plist.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR")"
  mkdir -p "$target_dir" "$INSTANCE_DIR/logs"
  printf '%s\n' "$rendered" > "$target.r"
  verify_unit "$target.r" "$target"
  # Refresh: unload before overwriting so the new unit takes effect.
  run_sanitized "$LAUNCHCTL_BIN" unload "$target" >/dev/null 2>&1 || true
  mv "$target.r" "$target"
  run_sanitized "$LAUNCHCTL_BIN" load "$target"
  echo "installed: $target"
  echo "instance:  $INSTANCE_DIR"
  echo "status:    launchctl list | grep gru-command"
}

uninstall_launchd() {
  local target="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [[ -f "$target" ]]; then
    [[ "$(service_ownership)" == "owned" ]] || {
      err "refusing to uninstall unrelated service unit: $target"; exit 1;
    }
    run_sanitized "$LAUNCHCTL_BIN" unload "$target" >/dev/null 2>&1 || true
    rm -f "$target"
    echo "uninstalled: $target"
  else
    echo "not installed (no $target)"
  fi
}

install_systemd() {
  local target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local target="$target_dir/gru-command.service"
  local rendered
  assert_service_owned_or_absent
  rendered="$(render_unit "$REPO_ROOT/install/systemd/gru-command.service.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR")"
  mkdir -p "$target_dir" "$INSTANCE_DIR/logs"
  printf '%s' "$rendered" > "$target.r"
  verify_unit "$target.r" "$target"
  mv "$target.r" "$target"
  run_sanitized "$SYSTEMCTL_BIN" --user daemon-reload
  run_sanitized "$SYSTEMCTL_BIN" --user enable gru-command.service
  # `enable --now` does not restart an already-active unit. restart starts
  # an inactive fresh unit and guarantees updated code for an active one.
  run_sanitized "$SYSTEMCTL_BIN" --user restart gru-command.service
  echo "installed: $target"
  echo "instance:  $INSTANCE_DIR"
  echo "status:    systemctl --user status gru-command"
}

uninstall_systemd() {
  local target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/gru-command.service"
  if [[ -f "$target" ]]; then
    [[ "$(service_ownership)" == "owned" ]] || {
      err "refusing to uninstall unrelated service unit: $target"; exit 1;
    }
    run_sanitized "$SYSTEMCTL_BIN" --user disable --now gru-command.service >/dev/null 2>&1 || true
    rm -f "$target"
    run_sanitized "$SYSTEMCTL_BIN" --user daemon-reload
    echo "uninstalled: gru-command.service"
  else
    echo "not installed"
  fi
}

# ---------------------------------------------------------------------------
# Full setup (E9): the one-line-install pipeline. When this script runs
# from a download/pipe (no checkout around it), clone first and re-exec
# inside the clone; inside a checkout, deps+build if needed, then wizard.
# ---------------------------------------------------------------------------
checkout_package_name() {
  # Parse JSON instead of grepping text: formatting and nested "name"
  # fields cannot spoof the top-level package identity.
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof value.name !== "string") process.exit(1);
      process.stdout.write(value.name);
    } catch { process.exit(1); }
  ' "$1/package.json"
}

is_product_checkout() {
  local root="$1" top canonical_root canonical_top
  [[ -f "$root/package.json" && -d "$root/src" && -f "$root/install.sh" ]] || return 1
  [[ "$(checkout_package_name "$root")" == "gru-command" ]] || return 1
  command -v git >/dev/null 2>&1 || return 1
  # Ask Git to validate its own metadata. This accepts real linked
  # worktrees but rejects empty directories and stale .git pointer files.
  top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || return 1
  git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1 || return 1
  canonical_root="$(cd "$root" && pwd -P)" || return 1
  canonical_top="$(cd "$top" && pwd -P)" || return 1
  [[ "$canonical_root" == "$canonical_top" ]]
}

inside_checkout() {
  is_product_checkout "$REPO_ROOT"
}

verify_checkout_origin() {
  local root="$1" configured
  configured="$(run_sanitized git -C "$root" remote get-url origin 2>/dev/null || true)"
  if [[ "$configured" != "$CLONE_ORIGIN" ]]; then
    err "refusing to update checkout with unexpected origin: $root"
    err "expected: $CLONE_ORIGIN"
    err "actual:   ${configured:-<missing>}"
    exit 1
  fi
}

update_checkout_path() {
  local root="$1"
  if [[ -n "$(run_sanitized git -C "$root" status --porcelain --untracked-files=normal)" ]]; then
    err "refusing to update a dirty checkout: $root"
    err "commit, stash, or remove local changes first; nothing was pulled"
    exit 1
  fi
  echo "updating source with git pull --ff-only…"
  if ! run_sanitized git -C "$root" pull --ff-only; then
    err "fast-forward-only update failed; resolve divergence manually (no reset was attempted)"
    exit 1
  fi
}

update_checkout() {
  update_checkout_path "$REPO_ROOT"
}

build_product() {
  cd "$REPO_ROOT"
  echo "installing dependencies…"
  if [[ -f package-lock.json ]]; then
    # Reproducible and non-mutating: `npm install` can rewrite a stale root
    # package version in package-lock.json, making the managed checkout
    # dirty and causing the next safe update to refuse itself.
    run_sanitized npm ci --no-audit --no-fund
  else
    run_sanitized npm install --no-audit --no-fund
  fi
  echo "building service and local CLIs…"
  run_sanitized npm run build
  if run_sanitized "$NODE_BIN" -e "const p=require('./package.json'); process.exit(p.scripts?.['build:web'] ? 0 : 1)"; then
    echo "building web UI…"
    run_sanitized npm run build:web
  fi
  for artifact in dist/main.js dist/wizard/main.js dist/cli/config-generate.js dist/decisions/cli.js; do
    if [[ ! -f "$artifact" ]]; then
      err "build did not produce $artifact"
      exit 1
    fi
  done
}

restart_owned_service_if_present() {
  local ownership
  ownership="$(service_ownership)"
  case "$ownership" in
    absent)
      echo "service restart: no installed Gru Command unit for this repo/instance"
      ;;
    foreign)
      err "refusing to restart unrelated service unit: $(service_target)"
      exit 1
      ;;
    owned)
      echo "restarting owned Gru Command service…"
      case "$OS" in
        darwin) install_launchd ;;
        linux) install_systemd ;;
      esac
      ;;
  esac
}

run_setup() {
  local source_update=0
  local cloned=0
  # The identity predicate parses package.json with Node, so enforce the
  # installer prerequisite before asking it to distinguish pipe vs clone.
  if ! node_ok; then
    err "node >= 22.19 required, found $("$NODE_BIN" --version) — upgrade Node.js first"
    exit 1
  fi
  if [[ "$UPDATE_REQUESTED" -eq 1 && ! -f "$INSTANCE_DIR/config.toml" ]]; then
    err "--update requires an existing configured instance at $INSTANCE_DIR/config.toml"
    err "run setup without --update for a fresh installation"
    exit 1
  fi
  if ! inside_checkout; then
    if [[ -n "${GRU_COMMAND_REEXEC:-}" ]]; then
      err "re-exec landed outside a product checkout: $REPO_ROOT"
      err "(the clone target must be a Gru Command checkout: package.json named gru-command + src/ + install.sh + .git)"
      exit 1
    fi
    command -v git >/dev/null 2>&1 || { err "git not found on PATH — install git first"; exit 1; }
    if [[ -e "$CLONE_TARGET" ]]; then
      if is_product_checkout "$CLONE_TARGET"; then
        echo "reusing existing checkout: $CLONE_TARGET"
        # Pull with the downloaded current installer before re-executing.
        # An old target script may not know the safe updater contract. Do not
        # execute a pre-positioned fork when this one-liner names another origin.
        verify_checkout_origin "$CLONE_TARGET"
        update_checkout_path "$CLONE_TARGET"
        source_update=1
      else
        err "clone target exists and is not a Gru Command checkout: $CLONE_TARGET"
        err "move it, or set GRU_COMMAND_TARGET to another path"
        exit 1
      fi
    else
      echo "cloning $CLONE_ORIGIN → $CLONE_TARGET"
      run_sanitized git clone "$CLONE_ORIGIN" "$CLONE_TARGET"
      cloned=1
    fi

    local forward=()
    [[ "$UPDATE_REQUESTED" -eq 1 ]] && forward+=(--update)
    [[ "$NO_INTERACT" -eq 1 ]] && forward+=(--no-interact)
    [[ "$FORCE" -eq 1 ]] && forward+=(--force)
    [[ "$ANSWERS_SET" -eq 1 ]] && forward+=(--answers "$ANSWERS")
    if [[ "$UPDATE_REQUESTED" -eq 0 && "$NO_INTERACT" -eq 0 && "$FORCE" -eq 0 && "$ANSWERS_SET" -eq 0 ]]; then
      GRU_COMMAND_REEXEC=1 \
        GRU_COMMAND_SOURCE_UPDATE=0 \
        GRU_COMMAND_SOURCE_UPDATED="$source_update" \
        GRU_COMMAND_FRESH_CLONE="$cloned" \
        exec bash "$CLONE_TARGET/install.sh"
    fi
    GRU_COMMAND_REEXEC=1 \
      GRU_COMMAND_SOURCE_UPDATE=0 \
      GRU_COMMAND_SOURCE_UPDATED="$source_update" \
      GRU_COMMAND_FRESH_CLONE="$cloned" \
      exec bash "$CLONE_TARGET/install.sh" "${forward[@]}"
  fi

  command -v git >/dev/null 2>&1 || { err "git not found on PATH — install git first"; exit 1; }

  if [[ "${GRU_COMMAND_SOURCE_UPDATE:-0}" -eq 1 || "$UPDATE_REQUESTED" -eq 1 ]]; then
    source_update=1
    update_checkout
  elif [[ "${GRU_COMMAND_SOURCE_UPDATED:-0}" -eq 1 ]]; then
    source_update=1
  elif [[ -f "$INSTANCE_DIR/config.toml" ]]; then
    source_update=1
    # A just-created clone is already at its fetched head. A retained clone
    # with retained config must update before build.
    [[ "${GRU_COMMAND_FRESH_CLONE:-0}" -eq 1 ]] || update_checkout
  fi

  build_product

  # A configured instance is an update, never a request to regenerate user
  # settings.
  if [[ "$source_update" -eq 1 && -f "$INSTANCE_DIR/config.toml" && "$ANSWERS_SET" -eq 0 && "$FORCE" -eq 0 ]]; then
    restart_owned_service_if_present
    echo "update complete; existing config preserved: $INSTANCE_DIR/config.toml"
    return 0
  fi

  local wizard_args=()
  [[ "$NO_INTERACT" -eq 1 ]] && wizard_args+=(--no-interact)
  [[ "$FORCE" -eq 1 ]] && wizard_args+=(--force)
  [[ "$ANSWERS_SET" -eq 1 ]] && wizard_args+=(--answers "$ANSWERS")
  if [[ "$NO_INTERACT" -eq 0 && "$FORCE" -eq 0 && "$ANSWERS_SET" -eq 0 ]]; then
    exec "$NODE_BIN" dist/wizard/main.js
  fi
  exec "$NODE_BIN" dist/wizard/main.js "${wizard_args[@]}"
}

case "$MODE" in
  print)
    case "$OS" in
      darwin) render_unit "$REPO_ROOT/install/launchd/$LABEL.plist.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR" ;;
      linux) render_unit "$REPO_ROOT/install/systemd/gru-command.service.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR" ;;
    esac
    ;;
  uninstall)
    case "$OS" in
      darwin) uninstall_launchd ;;
      *) uninstall_systemd ;;
    esac
    ;;
  service)
    if ! node_ok; then
      err "node >= 22.19 required, found $("$NODE_BIN" --version) — upgrade Node.js first"
      exit 1
    fi
    # E7 contract: dist/ must exist — the service runs node dist/main.js.
    if [[ ! -f "$REPO_ROOT/dist/main.js" ]]; then
      err "dist/main.js not found — run 'npm install && npm run build' in $REPO_ROOT first"
      exit 1
    fi
    case "$OS" in
      darwin) install_launchd ;;
      linux) install_systemd ;;
    esac
    ;;
  setup)
    run_setup
    ;;
esac
