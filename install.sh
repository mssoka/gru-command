#!/usr/bin/env bash
# Gru Command — OS service installer (EPICS E7 story 3; SPEC rulings 5/10).
#
# Registers the service with the platform service manager so it starts at
# login and restarts on crash (KeepAlive / Restart=on-failure — the OS is
# the out-of-band watcher; the in-process supervisor handles agent
# liveness, never the service's own).
#
# Usage:
#   ./install.sh              install (or refresh) + start the service
#   ./install.sh --print      render the unit to stdout; change nothing
#   ./install.sh --uninstall  stop the service and remove the unit
#
# Everything is resolved ABSOLUTELY at install time (repo root, node
# binary, instance dir) — service managers do not inherit your shell
# environment. No personal or project specifics belong in the templates.

set -euo pipefail

LABEL="com.gru-command.service"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_DIR="${GRU_COMMAND_HOME:-$HOME/.gru-command}"
# Resolve node to its REAL path: version managers (fnm/nvm/asdf) put
# ephemeral per-shell symlinks on PATH — a service unit pointing at one
# breaks on the next shell. The resolved install path is stable.
NODE_BIN="$(command -v node || true)"
if [[ -n "$NODE_BIN" ]]; then
  resolved="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
  [[ -x "$resolved" ]] && NODE_BIN="$resolved"
fi
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --print) MODE="print" ;;
    --uninstall) MODE="uninstall" ;;
    *) echo "unknown flag: $arg (valid: --print, --uninstall)" >&2; exit 2 ;;
  esac
done

err() { echo "install.sh: $*" >&2; }

if [[ -z "$NODE_BIN" ]]; then
  err "node was not found on PATH — install Node.js >= 22.19 first (https://nodejs.org)"
  exit 1
fi

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
# Platform installers
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
  printf '%s\n' "$rendered" > "$target.r"
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
  install)
    # dist/ must exist — the service runs node dist/main.js.
    if [[ ! -f "$REPO_ROOT/dist/main.js" ]]; then
      err "dist/main.js not found — run 'npm install && npm run build' in $REPO_ROOT first"
      exit 1
    fi
    case "$OS" in
      darwin) install_launchd ;;
      linux) install_systemd ;;
    esac
    ;;
esac
