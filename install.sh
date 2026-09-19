#!/usr/bin/env bash
# Gru Command — installer (EPICS E7 story 3 + E9 story 1; SPEC rulings 5/10/14).
#
# The GitHub ONE-LINE INSTALLER entry:
#   curl -fsSL https://raw.githubusercontent.com/mssoka/gru-command/main/install.sh | bash
# (no clone present → clone → deps → build → setup wizard → first-boot smoke)
#
# Usage:
#   ./install.sh                     full setup: deps + build →
#                                    setup wizard (clone-when-absent when
#                                    piped from the one-liner)
#   ./install.sh --answers '<json>'  same setup, non-interactive wizard
#                                    (unspecified answers = defaults)
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

err() { echo "install.sh: $*" >&2; }
# The range MUST cover the whole header block through the seam lines
# (GRU_COMMAND_ORIGIN / GRU_COMMAND_TARGET) — --help shows all of it.
usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) MODE="print" ; shift ;;
    --uninstall) MODE="uninstall" ; shift ;;
    --service) MODE="service" ; shift ;;
    --answers)
      [[ $# -ge 2 ]] || { err "--answers requires a JSON argument"; exit 2; }
      ANSWERS="$2"; shift 2 ;;
    --answers=*)
      ANSWERS="${1#--answers=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown flag: $1 (valid: --answers <json>, --service, --print, --uninstall, -h|--help)"; exit 2 ;;
  esac
done

# Contradicting combos fail loud instead of resolving silently: --answers
# is a SETUP-mode argument; pairing it with another mode drops one of them.
if [[ -n "$ANSWERS" && "$MODE" != "setup" ]]; then
  err "--answers is only valid with setup mode, but mode is --$MODE — pass --answers alone (setup is the default)"
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
# optional service-registration step)
# ---------------------------------------------------------------------------
install_launchd() {
  local target_dir="$HOME/Library/LaunchAgents"
  local target="$target_dir/$LABEL.plist"
  local rendered
  rendered="$(render_unit "$REPO_ROOT/install/launchd/$LABEL.plist.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR")"
  mkdir -p "$target_dir" "$INSTANCE_DIR/logs"
  printf '%s\n' "$rendered" > "$target.r"
  verify_unit "$target.r" "$target"
  # Refresh: unload before overwriting so the new unit takes effect.
  launchctl unload "$target" >/dev/null 2>&1 || true
  mv "$target.r" "$target"
  launchctl load "$target"
  echo "installed: $target"
  echo "instance:  $INSTANCE_DIR"
  echo "status:    launchctl list | grep gru-command"
}

uninstall_launchd() {
  local target="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [[ -f "$target" ]]; then
    launchctl unload "$target" >/dev/null 2>&1 || true
    rm -f "$target"
    echo "uninstalled: $target"
  else
    echo "not installed (no $target)"
  fi
}

install_systemd() {
  local target_dir="$HOME/.config/systemd/user"
  local target="$target_dir/gru-command.service"
  local rendered
  rendered="$(render_unit "$REPO_ROOT/install/systemd/gru-command.service.template" "$NODE_BIN" "$REPO_ROOT" "$INSTANCE_DIR")"
  mkdir -p "$target_dir" "$INSTANCE_DIR/logs"
  printf '%s' "$rendered" > "$target.r"
  verify_unit "$target.r" "$target"
  mv "$target.r" "$target"
  systemctl --user daemon-reload
  systemctl --user enable --now gru-command.service
  echo "installed: $target"
  echo "instance:  $INSTANCE_DIR"
  echo "status:    systemctl --user status gru-command"
}

uninstall_systemd() {
  if systemctl --user list-unit-files 2>/dev/null | grep -q '^gru-command.service'; then
    systemctl --user disable --now gru-command.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/gru-command.service"
    systemctl --user daemon-reload
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
inside_checkout() {
  [[ -f "$REPO_ROOT/package.json" && -d "$REPO_ROOT/src" && -f "$REPO_ROOT/install.sh" ]]
}

run_setup() {
  if ! inside_checkout; then
    # One-liner case (e.g. curl | bash): clone to the target dir.
    # A re-exec guard: if we already re-executed once and STILL are not
    # inside a checkout, fail loud — never loop.
    if [[ -n "${GRU_COMMAND_REEXEC:-}" ]]; then
      err "re-exec landed outside a product checkout: $REPO_ROOT"
      err "(the clone target must contain package.json + src/ + install.sh)"
      exit 1
    fi
    command -v git >/dev/null 2>&1 || { err "git not found on PATH — install git first"; exit 1; }
    if [[ -e "$CLONE_TARGET" ]]; then
      if [[ -d "$CLONE_TARGET" && -f "$CLONE_TARGET/package.json" && -d "$CLONE_TARGET/.git" ]]; then
        echo "reusing existing checkout: $CLONE_TARGET"
        echo "notice: not updating the checkout — run git pull yourself"
      else
        err "clone target exists and is not a Gru Command checkout: $CLONE_TARGET"
        err "move it, or set GRU_COMMAND_TARGET to another path"
        exit 1
      fi
    else
      echo "cloning $CLONE_ORIGIN → $CLONE_TARGET"
      git clone "$CLONE_ORIGIN" "$CLONE_TARGET"
    fi
    # Re-exec INSIDE the clone: absolute re-resolution, one code path.
    if [[ -n "$ANSWERS" ]]; then
      GRU_COMMAND_REEXEC=1 exec bash "$CLONE_TARGET/install.sh" --answers "$ANSWERS"
    fi
    GRU_COMMAND_REEXEC=1 exec bash "$CLONE_TARGET/install.sh"
  fi

  # Inside the checkout.
  if ! node_ok; then
    err "node >= 22.19 required, found $("$NODE_BIN" --version) — upgrade Node.js first"
    exit 1
  fi
  cd "$REPO_ROOT"
  # ALWAYS install deps: a pulled checkout with new dependencies must not
  # crash at wizard exec — npm install is a no-op when already satisfied.
  echo "installing dependencies…"
  npm install --no-audit --no-fund
  if [[ ! -f dist/main.js || ! -f dist/wizard/main.js ]]; then
    echo "building…"
    npm run build
  fi
  # A partial build must die HERE, named — not as MODULE_NOT_FOUND at exec.
  for artifact in dist/main.js dist/wizard/main.js; do
    if [[ ! -f "$artifact" ]]; then
      err "build did not produce $artifact"
      exit 1
    fi
  done
  if [[ -n "$ANSWERS" ]]; then
    exec "$NODE_BIN" dist/wizard/main.js --answers "$ANSWERS"
  fi
  exec "$NODE_BIN" dist/wizard/main.js
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
