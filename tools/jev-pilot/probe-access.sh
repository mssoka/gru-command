#!/usr/bin/env bash
# STEP 0 — ACCESS GATE for the Jev calibration pilot (gru-command-jev-pilot).
#
# Probe-verifies a REAL Jev completion via OpenRouter and captures raw
# request/response receipts under tools/jev-pilot/evidence/.
#
# Route discovery (all receipts preserved in evidence/):
#   1. POST /api/v1/chat/completions, raw documented shape  -> 400 "Input
#      required: specify prompt or messages" (model ids DID resolve)
#   2. same, ~typesafe/jev-latest alias                     -> identical 400
#   3. shape inside the messages envelope                   -> 400 "decisions
#      model ... Use the /api/alpha/decisions endpoint instead"
#   4. POST /api/alpha/decisions with the documented shape  -> Zod schema
#      validation: questions need `instructions`; choice needs record-type
#      `criteria`; score needs array-type `criteria`
#   5. schema-correct documented shape at /api/alpha/decisions -> THIS probe.
#
# Usage: bash tools/jev-pilot/probe-access.sh
#   Reads OPENROUTER_API_KEY from env, else falls back to the macOS keychain
#   (service "omnigent", account "openrouter" — the factory key).
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root (lane worktree)
EVID="tools/jev-pilot/evidence"
mkdir -p "$EVID"

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  KEY="$OPENROUTER_API_KEY"
else
  KEY="$(security find-generic-password -s omnigent -a openrouter -w 2>/dev/null || true)"
fi
if [ -z "$KEY" ]; then echo "FATAL: no OpenRouter key (env OPENROUTER_API_KEY or keychain omnigent/openrouter)" >&2; exit 2; fi

URL="https://openrouter.ai/api/alpha/decisions"

# Trivial payload in the documented Jev shape (edge-analysis doc, Play A),
# schema-corrected per the /api/alpha/decisions Zod validation receipts:
# one noul, one choice (criteria = per-option record), one score (criteria =
# ordered array). Atomic questions only — the replay discipline.
cat > "$EVID/req-decisions.json" <<'JSON'
{
  "model": "typesafe/jev-1.13",
  "state": "Orchestrator health probe: minion pane replied to a 1-word liveness probe with: OK — I am here and working! (probe exit code 0, model id glm-5.3, last 3 dispatch outcomes: ok / ok / ok)",
  "questions": {
    "provider_alive": {
      "type": "noul",
      "instructions": "The provider responded and can serve requests"
    },
    "read_class": {
      "type": "choice",
      "instructions": "Classify the probe reply text into exactly one class",
      "options": ["clean_ok", "chatty_ok", "quota_403_monthly", "quota_403_5h", "balance_402", "burst_1302", "wall_1308", "network_error"],
      "criteria": {
        "clean_ok": "A bare OK or minimal acknowledgement, nothing more",
        "chatty_ok": "A clearly-alive reply with extra words, emojis or enthusiasm",
        "quota_403_monthly": "HTTP 403 wording indicating a monthly quota is exhausted",
        "quota_403_5h": "HTTP 403 wording indicating a 5-hour window quota is exhausted",
        "balance_402": "HTTP 402 payment-required / insufficient balance wording",
        "burst_1302": "HTTP 1302 burst/short-window rate limit wording",
        "wall_1308": "HTTP 1308 hard cap / quota wall wording",
        "network_error": "Connection failure, timeout or DNS error instead of a reply"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is this probe outcome for orchestration routing",
      "criteria": [
        "low: routine probe, no action needed",
        "high: provider dead or misrouted; action required now"
      ]
    }
  }
}
JSON

curl -sS "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: https://github.com/mssoka/gru-command" \
  -H "X-Title: gru-command-jev-pilot" \
  --data @"$EVID/req-decisions.json" \
  -o "$EVID/rsp-decisions-final.body" \
  -D "$EVID/rsp-decisions-final.headers" \
  -w 'http_code=%{http_code} time_total=%{time_total} time_connect=%{time_connect}\n' \
  > "$EVID/rsp-decisions-final.meta" 2>&1 || true

cat "$EVID/rsp-decisions-final.meta"
echo "--- response body ---"
cat "$EVID/rsp-decisions-final.body"; echo
