# Question-design notes — optional input for the fold-in

Per Amendment 1 (2026-09-19): the labeled-history replay is DROPPED as a
gate. These question sets exist purely as design input for whoever builds
the Jev-backed DecisionService — incident vocabulary from the edge-analysis
doc and the field record, shaped in the live-verified API schema. Play A is
the only set exercised against the live endpoint (receipts in `evidence/`).

Discipline (ours + theirs): **atomic questions only** — one gut-check
judgment each; decompose multi-factor judgments and combine in code, never
in the model. Low confidence ⇒ escalate.

## Play A — probe-read classifier (validated live, 2 receipts + demo run)

state = raw probe stdout + exit code + model id + last 3 dispatch outcomes

| question  | type   | notes                                                            |
| --------- | ------ | ---------------------------------------------------------------- |
| provider_alive | noul | true/false criteria descriptions (receipt-verified shape)         |
| read_class | choice | clean_ok, chatty_ok, quota_403_monthly, quota_403_5h, balance_402, burst_1302, wall_1308, network_error |
| severity   | score  | 2-level rubric: low routine → high action-now                    |

Live results on the chatty-OK fixture: `chatty_ok` @ confidence 1.0,
alive 0.96–0.97, severity low — the exact class the strict `^OK$` matcher
mis-grades today.

## Play B — watcher-alert pre-grade (sketch, not exercised)

state = alert payload + pane id + last 3 transcript lines + row status

| question    | type   | options / rubric                                                     |
| ----------- | ------ | -------------------------------------------------------------------- |
| needs_action | noul  | "This transition requires ledger ops or a relay"                     |
| alert_class | choice | settle_echo, boot_race, flush_race, real_stall, provider_death, phantom_row, user_terminal, unknown |
| severity    | score  | low noise → high real                                                |

## Play C — destructive-call gate (sketch, not exercised)

state = exact command + targets (paths, pane ids, PIDs) + owning row + lsof output

| question          | type  | notes                                              |
| ----------------- | ----- | -------------------------------------------------- |
| is_destructive    | noul  | "Successful execution deletes/irreversibly changes user data or stops live processes" |
| targets_match_scope | noul | "Every target is owned by the job row invoking this" |
| needs_human       | noul  | ambiguity / blast radius → pause-and-ask            |

Incident vocabulary for criteria text (electric-loom sweep, pYR kill order,
sheep-pane kills — see AGENTS.md field record): untracked-file sweeps,
orphaned servers, forwarded-report provenance, id-proximity sweeps.

## Play D — Perkins findings triage (sketch, not exercised)

state = finding title + evidence snippet + the fix commit diff it critiques

| question              | type  | notes                                            |
| --------------------- | ----- | ------------------------------------------------ |
| likely_real           | noul  | "The described defect reproduces in the shown evidence" |
| is_vacuous            | noul  | "A gate/test that cannot fail by deleting the guarded thing" |
| needs_mutation_leg    | noul  | acceptance requires a RED-before-fix discriminator |
| priority              | score | low → high                                       |

## Schema reminders (live-verified; enforced by the endpoint's Zod layer)

- every question needs `instructions`
- `noul` → `criteria: { true: "...", false: "..." }`
- `choice` → `options: [...]` + `criteria: { <option>: "..." }` (record)
- `score` → `criteria: ["low: ...", "high: ..."]` (ordered array)
- answers: `noul` probability; `choice` pick + per-option probabilities +
  confidence; `score` level index + distribution + confidence
- reference client: `decisions-client.mjs` (validates before spending a call)
