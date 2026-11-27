# FOR YOU: the owner card standard

FOR YOU is the one surface for things only the owner can decide or do.
The person reading it is **not** the person (or minion) who wrote it: no
build logs, no ids, no settings names, no infrastructure vocabulary. A card
the owner cannot read is a card that never reached them.

This is the written standard the code enforces (issue #570). The boundary is
`assertOwnerCardLanguage` in `src/notifications/owner-language.ts`.

## The two card shapes

1. **Question card** — a typed decision (`decision_json`). It carries the
   question, one or two sentences of context, Gru's recommendation, why it
   cannot be decided below the owner, the concrete options with their
   consequences, and the do-nothing line.
2. **Notice card** — a title plus the central, static guidance for its kind:
   why the owner is seeing it, what happens if they do nothing, and the
   manual step. A notice never grows a control of its own.

A third row type, the **Book of Lessons proposal**, is decided on the
proposal itself — Accept all, Reject all, or Keep / Drop per change and
Save my choices (see LESSONS.md); its notice still has to read plainly.

## Required fields

Every question card states:

| Field | Rule |
|---|---|
| `question` | One line, plain words, about the owner's choice — not the machinery. |
| `context` | One or two sentences on what happened and why it matters. |
| `recommendation` | Required. Either what Gru recommends, or the explicit no-preference form (below). |
| `recommendedOption` | Optional. The `id` of the option the recommendation picks; the card marks that choice "Gru's pick". |
| `ifNothing` | Required. What happens if the owner does nothing. |
| `whyNotDelegable` | Why Silas/Gru cannot decide it. |
| `options[]` | Concrete choices; every `consequence` says what happens or does not happen. |

**No automatic do-nothing default.** When inaction really changes nothing,
say so deliberately with `OWNER_NOTHING_DEFAULT` ("If you do nothing,
nothing changes and this request stays open until it is answered or
withdrawn."). When inaction has a specific consequence, state that one
instead: GC asks again in 30 days, the sweep stays paused, the disk keeps
filling, the job stays parked.

**No silent missing recommendation.** A producer with no preference writes
the explicit form, which the card renders without the "Gru recommends:"
prefix:

> No recommendation — either choice is fine, because … (say why)

`recommendation: null` is refused at the boundary, and a pre-upgrade row
that has none renders no recommendation line at all (the card never invents
one).

`ifNothing` is **required on write and optional on read**: a row written
before this standard renders its choices with no invented do-nothing line.

**The pick is stated, never inferred.** A recommendation such as "choose
the first option" makes the owner count buttons, so a producer whose
recommendation is one of the options names that option in
`recommendedOption`, and the card marks it (a tag, a yellow ring and the
filled button, and names it to a screen reader as the description of
that choice). The boundary keeps the mark honest:

- it must be the `id` of one of the decision's own options;
- it needs a `recommendation` beside it (a marked choice states its reason);
- the no-preference form marks no option ("either choice is fine" and a
  marked choice contradict each other in front of the owner).

It is optional: a recommendation that is not one of the options, a
discussion-only card and a row written before the field existed mark
nothing, and the browser never guesses a pick from the recommendation's
words. Options attached later to a discussion card
(`POST /api/notifications/:id/decision-options`) carry no mark of their
own, and the route refuses a body that sends one. A mark the card already
carried stays only on the option it was written about, attached unchanged
(same id, label and consequence); otherwise it is cleared, because the
stored recommendation was not written about the new choice. A stored mark
the boundary would refuse is dropped when the row is read, never the whole
question. The mark is part of the decision the browser echoes back with a
choice, so a card whose mark changed is `decision_changed` like any other
edit. The owner is free to choose any option, marked or not.

## Where the owner's text ends and evidence begins

`title`, `question`, `context`, `recommendation`, `ifNothing`,
`whyNotDelegable`, `options[].label` and `options[].consequence` are
**owner-facing** and are checked.

`detail` is the **evidence slot**. It is never checked and is shown verbatim
behind the card's "Details" disclosure. Identifiers, paths, hashes, logs,
resolved commands, settings names and raw errors belong there and nowhere
else. On a `needs-owner` row the card face is guidance and choices only: a
short `detail` is never promoted to it.

Three other surfaces read `detail` and are named so they are not mistaken
for the decision face: the arrival toast and the browser notification body
carry the row's `detail`; the Book of Lessons proposal row renders its
proposal summary line; and a card's `Result:` line shows the producer's own
resolution text. They are evidence readers, not the owner's question, and
this boundary does not inspect them.

## Refused vocabulary

Word-boundary matches, case-insensitive, on every owner-facing string, with
the plural refused as the same word (`lanes`, `heists`, `breakers`, `gates`,
`dispatches`):

- `lane`, `heist`, `breaker`, `re-arm`, `quorum`, `dispatch`, `gate` — say
  what the owner gets instead ("saved workspace", "work", "safety stop",
  "restart", "the app starts it", "check").
- Machine tokens: absolute or home-relative paths, Windows paths,
  `.gru-command/…`-style folder paths, 40- and 64-character hex ids,
  `job-…` ids, `pid`, `refs/…`, `sha256`, raw `Error:` text, `[section]`
  config sections, `key = value` config keys and `UPPER_CASE` internal
  constants.

Allowed on the face, because they are the subject of the sentence and not
noise: repository slugs (`mssoka/gru-command`), PR/MR numbers (`PR256`,
`MR 12`, `#256`), durations (`30 days`, `1.5 s`, `4.0 GB`) and version
numbers (`1.0.2`).

## Notice guidance

`ownerNoticeGuidance(kind)` in the same module holds, per registered owner
kind, `whyAsked`, `ifNothing` and `howTo`. The boundary refuses a
`needs-owner` notice whose kind has no entry (there is no silent generic
fallback sentence), so a new owner kind ships with its guidance. An
informational notice says so explicitly: "Nothing is asked of you; this is
information …".

## Where the check runs

The boundary is every write of owner-facing text, once the effective
routing is `needs-owner`:

1. `NotificationCenter.post`
2. `NotificationCenter.openIncident` (the dedupe path too)
3. `NotificationCenter.attachDecisionOptions` — the incoming option labels
   and consequences only; a pre-upgrade discussion row's stored question and
   recommendation are not re-judged
4. `NotificationCenter.adoptLegacyDecision` — the incoming decision; the
   row's stored legacy title is not rewritten, so it is not re-judged
5. `LedgerApi.updateNotificationDetail` when the row's effective routing is
   `needs-owner` and the title changes

**Fail-forward for swallowing or retrying producers.** A producer that
retries or swallows its post (the Gru wake stops, the lessons conflict
notice) must never lose the stop because its text was refused:
`ownerNoticeWithFallback` posts the fixed plain title
(`OWNER_FALLBACK_NOTICE_TITLE`) and moves the refused text into `detail`.

A refusal is a producer bug and fails loud, naming the field and the
offending token — the producer fixes the copy, never the validator.

## Writing a card

1. Write the title as the one sentence the owner would say to a colleague.
2. Put the choice in the question, the reason in the context, and the
   recommendation or the explicit no-preference form.
3. State the do-nothing outcome honestly (`OWNER_NOTHING_DEFAULT` only when
   it is true).
4. Give every option a consequence in outcomes, not mechanisms.
5. Move every id, path, hash, log line and setting name into `detail`.
6. For a notice, register `whyAsked` / `ifNothing` / `howTo` for its kind.

Gru's own escalation contract (`POST /api/notifications/needs-owner`,
`roles/gru.md`) carries the same rules, and the route refuses a card that
breaks them.
