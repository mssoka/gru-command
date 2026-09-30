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

# Allowlist semantics (Perkins r2 note): slash-terminated PATH
# PREFIXES ('/home/tester/', '/root/repo/') strip unconditionally —
# the trailing slash IS the boundary, so '/home/tester-evil' never
# matches them. COMPLETE TOKENS ('mssoka/gru-command', 'herdr is
# not', and the bare fixture-home token) strip only when followed by
# end-of-line or a NON-identifier char — a lookalike with more
# identifier chars is a different token and stays a violation. The
# RESIDUAL after stripping is re-checked: anything still matching the
# personal-pattern set is a real finding.
check_matches() {
  # $1 = grep matches, each already carrying the "file:line:text" prefix.
  local match residual
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue                   # heredoc tail newline
    residual="$(printf '%s\n' "$match" | sed -E \
      -e 's#/home/tester/##g' \
      -e 's#/root/repo/##g' \
      -e 's#/home/tester([^A-Za-z0-9_-]|$)#\1#g' \
      -e 's#mssoka/gru-command([^A-Za-z0-9_-]|$)#\1#g' \
      -e 's#herdr is not([^A-Za-z0-9_-]|$)#\1#g')"
    if ! printf '%s\n' "$residual" | grep -qE "$PATTERNS"; then
      continue # the allowlisted token was the whole story
    fi
    echo "hygiene violation: $match"
    hits=$((hits + 1))
  done <<< "$1"
}

# One grep process per BATCH of files, not per file: spawn-per-file used
# to dominate the gate's runtime (~1000 spawns, seconds of sys time),
# which starved the always-on gate past its test ceiling under concurrent
# load. Scan semantics are unchanged — same patterns, same -I binary skip,
# same per-match allowlist re-check — and a batch-level grep error (exit 2:
# unreadable file, etc.) falls back to per-file scans so the failing file
# is still NAMED and the gate still fails loud, never swallowed.
BATCH_SIZE=200
BATCH=()
flush_batch() {
  if [[ ${#BATCH[@]} -eq 0 ]]; then
    return 0
  fi
  local rc=0 batch_out=""
  batch_out="$(grep -IEn "$PATTERNS" -- "${BATCH[@]}" 2>/dev/null)" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    local f rc2=0 f_out
    for f in "${BATCH[@]}"; do
      [[ -f "$f" ]] || continue
      [[ "$f" == "$GATE_SELF" ]] && continue
      rc2=0
      f_out="$(grep -IEn "$PATTERNS" -- "$f" 2>/dev/null)" || rc2=$?
      if [[ "$rc2" -eq 2 ]]; then
        echo "hygiene-grep: grep failed (exit 2) while scanning: $f" >&2
        exit 1
      fi
      check_matches "$f_out"
    done
  else
    check_matches "$batch_out"
  fi
  BATCH=()
}

while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  [[ "$file" == "$GATE_SELF" ]] && continue   # the gate's own pattern list
  BATCH+=("$file")
  if [[ ${#BATCH[@]} -ge $BATCH_SIZE ]]; then
    flush_batch
  fi
done <<< "$FILES"
flush_batch

if [[ "$hits" -gt 0 ]]; then
  echo "hygiene-grep: ${hits} violation(s) — personal paths/names must not ship (SPEC ruling 8)" >&2
  exit 1
fi
echo "hygiene-grep: clean (zero personal paths / project names outside the allowlist)"
