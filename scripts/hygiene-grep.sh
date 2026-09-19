#!/usr/bin/env bash
# Gru Command — repo hygiene gate (E9; SPEC ruling 8).
#
# The shared product repo ships orchestration only: ZERO personal paths,
# ZERO personal/project names. This gate greps the tree (tracked files
# plus untracked-but-not-ignored, so it works in a dirty worktree) and
# fails on any hit outside the allowlist:
#
#   allowlisted  mssoka/gru-command            the GitHub owner URL in the
#                                              install one-liner / clone
#                                              command (the sole sanctioned
#                                              owner reference)
#   allowlisted  "herdr is not"                SPEC.md's explicit
#                                              non-integration statement
#                                              (frozen constitution text)
#   allowlisted  /home/tester                  generic fixture home used by
#                                              the test suite
#   allowlisted  /root/repo/                   generic fixture paths in the
#                                              worktree-manager tests
#
# Usage: bash scripts/hygiene-grep.sh   (exit 0 clean, 1 with findings)

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v git >/dev/null 2>&1; then
  echo "hygiene-grep: git not found" >&2
  exit 1
fi

FILES="$(git ls-files --cached --others --exclude-standard)"
if [[ -z "$FILES" ]]; then
  echo "hygiene-grep: no files to scan"
  exit 0
fi

# Patterns: personal home paths (any /Users/, any /home/, /root/ —
# capitalized usernames included), the builder's name, the multiplexer
# project name, this lane's worktree suffix, and the GitHub owner (the
# owner has its own URL allowlist above). Epic-numbered test tmpdir
# prefixes (e.g. gru-command-e4-) are product numbering, not personal.
PATTERNS='/Users/|/home/|/root/|moses|herdr|gru-command-e9|mssoka'
GATE_SELF="scripts/hygiene-grep.sh"

hits=0
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  [[ "$file" == "$GATE_SELF" ]] && continue   # the gate's own pattern list
  # grep exit 0 = match, 1 = no match, 2 = real error (unreadable etc.) —
  # exit 2 must fail loud, never be swallowed like a clean no-match.
  rc=0
  grep_out="$(grep -IEn "$PATTERNS" -- "$file" 2>/dev/null)" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    echo "hygiene-grep: grep failed (exit 2) while scanning: $file" >&2
    exit 1
  fi
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue                   # heredoc tail newline
    # Line format: <file>:<line>:<text> (grep -n over one file at a time)
    case "$match" in
      *"/home/tester"*) continue ;;                       # generic fixture home
      *"/root/repo/"*) continue ;;                       # generic fixture path
      *"mssoka/gru-command"*) continue ;;                 # install/clone URL
      *"herdr is not"*) continue ;;                       # frozen SPEC statement
    esac
    echo "hygiene violation: ${file}:${match#"${file}:"}"
    hits=$((hits + 1))
  done <<< "${grep_out}"
done <<< "$FILES"

if [[ "$hits" -gt 0 ]]; then
  echo "hygiene-grep: ${hits} violation(s) — personal paths/names must not ship (SPEC ruling 8)" >&2
  exit 1
fi
echo "hygiene-grep: clean (zero personal paths / project names outside the allowlist)"
