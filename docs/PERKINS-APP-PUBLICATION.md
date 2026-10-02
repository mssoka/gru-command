# Perkins App review publication

How Perkins verdicts are published on github.com by the installed Perkins
GitHub App (`perkins-review[bot]`) instead of whoever is logged into the
`gh` CLI. Operator-facing companion to [CONFIG.md](./CONFIG.md) and the
review flow in [FLOW.md](./FLOW.md).

Owner ruling (2026-09-27): the reviewing GitHub identity is the installed
App, never a personal account. This changes **authorship only** — the
publication contract stays the COMMENT-only, commit-bound review it has
always been. No APPROVE/REQUEST_CHANGES semantics, no branch protection,
and no merge authority are granted or changed.

## The runtime bundle

The App credential bundle lives under the service's **instance dir**
(the directory holding `config.toml`, default `~/.gru-command/`), never
inside a repository checkout. The resolution rule is exact: the instance
dir is authoritative; when `data_dir` relocates service state and the
instance dir holds no bundle, a bundle under `<data_dir>/perkins/` is
honored as a fallback, and the instance dir wins if both exist.

```
<instance_dir>/perkins/config      literal KEY=VALUE data (0600)
<instance_dir>/perkins/app-key.pem the App's RSA private key (0600)
```

`config` is literal data — it is parsed as bytes, never evaluated or
sourced as a shell script, so `$HOME` in a value stays the literal string:

```
app_id=4366368
key_path="/absolute/path/to/app-key.pem"
installation_id_widget-shop=111222333
installation_id_solarity-services=999888777
```

- `key_path` may be quoted or unquoted; a relative path resolves against
the bundle dir (but is not confined to it — `..` segments are permitted),
and an absolute POSIX path is accepted as written. Windows drive (`C:\`)
and UNC (`\\server\share`) forms are accepted as written on Windows; on
the supported POSIX deployment they are not absolute, so they are refused
by name instead of being resolved against the process working directory —
never a credential source. A single leading backslash is not an absolute
form — only a UNC path starts with two — so it resolves against the bundle
dir like any other relative path. Wherever the key lives, it passes the
same file-level checks; the bundle dir remains the audit boundary — the
config that names the key still lives there.
- `installation_id_<owner>` takes one entry per reviewed repository owner,
  including hyphenated organization names. Lookup is case-insensitive.
- The key must be the RSA PEM downloaded from the App settings page.
- The files must be regular files owned by the service user, owner-only
  (no group/other access, no setuid/setgid/sticky bits) and owner-readable
  — 0600 recommended, and a hardened 0400 works. The bundle directory
  itself must be exactly an owner-owned 0700 directory; 0500 is rejected.
  Publication time enforces all of this — including rejecting symlinked
  files — and fails closed, naming the mode it found in the message.
  (Windows deployments: ownership and mode enforcement are not applied,
  and symlink rejection is best-effort — an lstat check without an
  `O_NOFOLLOW` backstop; restrict the bundle with filesystem ACLs.)
- The bundle is provisioned by the owner (App settings + installation);
  the service only reads it.

## Mode selection (startup)

Selection is by bundle **presence**, checked once at service start: any
bundle-shaped presence — a regular file, a symlink, a directory, even an
unreadable path — selects App mode, and a broken bundle then fails loudly
at publication time (never at boot) rather than silently degrading to a
personal credential:

| Bundle | github.com publication |
|---|---|
| `<instance_dir>/perkins/config` present (or `<data_dir>/perkins/config` for a relocated deployment) | Perkins App poster |
| absent from both roots | legacy `gh` poster, byte-for-byte unchanged |

GitLab routing is untouched in both modes.

With a bundle present, github.com is the **only** supported GitHub host.
The service's GitHub discriminator routes `github.com`, its subdomains,
and `*.github` hosts to this publisher, where every host other than exact
`github.com` **fails closed**: the App's credentials are bound to
`api.github.com` and are never sent anywhere else, and no silent
personal-credential fallback exists.

This is a deliberate compatibility boundary — hosting App reviews on
another host requires a separate, explicit publisher decision.

## The identity chain (all before the irreversible POST)

1. PR URL + repository-origin validation, identical to the legacy poster.
2. Bundle load and validation — both files owner-only, owner-readable
   regular files (0600 recommended); missing/invalid/inaccessible
   credentials fail closed with sanitized diagnostics — key bytes never
   appear in an error, and no personal credential is ever consulted.
3. A short-lived RS256 App JWT (`iss` = `app_id`, ≤ 10 minutes) mints an
   installation access token **down-scoped to the one repository and
   `pull_requests: write` (+ implicit metadata read)**.
4. The token grant is verified: pull-request write permission and
   repository coverage proved by the provider response.
5. `GET /app` proves the authenticated App is the configured `app_id`;
   its slug derives the expected bot identity `<slug>[bot]`.
6. The PR head must equal the round's frozen target SHA.
7. The review POST is `{body, event: "COMMENT", commit_id: <target>}`.
8. The response's author must be the verified App bot
   (`<slug>[bot]`, `type: "Bot"`) on the exact `commit_id` — and a 2xx
   whose receipt cannot be proved is resolved by the same bounded
   reconciliation as an unknown POST outcome, never a blind retry.

Every request goes to a hard-coded `https://api.github.com` with redirects
refused; tokens never appear in URLs, logs, or error text. An installation
token is never used against `/user` — it is not a user token.

## Failures, ambiguous delivery, and recovery

Token expiry, missing permission, suspended or mismatched installation,
identity mismatch: the round is recorded but NOT posted; the escalation is
actionable and sanitized. Nothing falls back to a personal `gh` identity.
A mint-time HTTP 403 that GitHub marks as secondary rate limiting is
diagnosed as such, distinct from a suspended installation.

If the review POST's outcome is unknown (network loss after send, a 3xx
that slipped past redirect refusal, an unreadable response, 5xx), a
**bounded reconciliation** lists the PR's reviews and credits the delivery
only on provider proof:

- the App bot as author (`type: "Bot"`);
- `COMMENTED` state;
- the exact frozen `commit_id`;
- a byte-identical body;
- submitted no earlier than 60 s before this round's POST began — the
  60 s margin tolerates provider clock skew, and older rounds' identical
  bytes outside it are never credited.

The **second** lookup of a failed attempt is fail-closed: when the review
wave's failure seam reconciles the same publication attempt again (an
explicit post-failure caller context on `VerdictPoster.reconcile`, reaching
this publisher through `AutoVerdictPoster`), it throws an honest unresolved
error before any provider read — `post()` already owns the one bounded
strict-window reconciliation, and a failed post is never upgraded into a
receipt or an absence certificate by a second recovery lookup. Ordinary
standalone/recovery reconciliation (no context) keeps its distinct prior
rules: any provider-proved exact head/body match is credited, including a
publication whose submission time the provider does not state.

Absence is certified only by full coverage: the walk visits every page up
to the largest `rel="last"` page number any response reported — a list
that grows mid-walk stays unresolved only while the grown list is not
covered within the lookup bound — or, when no Link header is present at
all, it reaches a short final page (fewer than 100 reviews — GitHub's own
end-of-list signal). A Link header that carries no usable `rel="last"` is
not an end-of-list signal: the walk continues bounded and stays unresolved
rather than certifying absence from a rewritten header. A header whose
`rel="last"` entries are malformed or contradict each other is worse than
unusable: it poisons the walk's completeness evidence, so absence is never
certified from that walk — not even from an earlier valid bound — though
an independently proved exact match is still credited. A foreign author
with the same bytes is never credited; a malformed list — one with an
entry that is not a decidable review record (an array, a primitive, or a
record without the provider's numeric review id) — a failed request, an
exhausted page bound, or a predicate-complete review that cannot form a
receipt id is never treated as absence — the delivery stays explicitly
unproven and the review is never blindly re-posted.

**Runbook for an unproven delivery.** Open the pull request's reviews. A
COMMENT review authored by `<slug>[bot]` (for this App:
`perkins-review[bot]`), on the exact frozen head, whose body matches the
one the round published — and whose submission time falls within this
round — means it landed: record the receipt manually per the escalation
(the escalation names the expected bot login and head). Otherwise it was
not delivered, and a retry on a **new** frozen head is safe; re-running
against the same head without checking first is what duplicates reviews.

Recovery across the publisher-identity change: a review attempt from the
historical personal-identity era whose original author cannot be proved
stays unresolved rather than being re-attributed or duplicated. Prior
receipts and reports are preserved unchanged.

## Activation and live check (owner-controlled)

1. Land and deploy the approved code (owner merges; worker never merges).
2. Confirm the bundle exists under the *deployed instance dir* (or its
   relocated `data_dir`); no App reinstall and no new permissions are
   required.
3. Restart the service (owner action).
4. Trigger one authorized review round; the delivered review must show
   **`perkins-review[bot]`** as the reviewer on the exact frozen head.

Note that App mode changes the **publisher**, not the review preflight:
the round still routes through the preflight's `gh`-based code-host probe,
so the worker's `gh` login must remain valid for a round to reach Perkins
at all (a failed probe routes to the bmad-review fallback, never to a
personal-identity publication).

Until 3–4 are done, reviews are still posted by the deployed personal
publisher — do not claim App activation before then.

## Where the code lives

| File | Role |
|---|---|
| `src/dispatch/perkins-github-app.ts` | bundle parsing, JWT, token mint, App poster, startup factory |
| `src/main.ts` | one-line poster injection at startup (`createStartupVerdictPoster`) |
| `test/perkins-github-app.test.ts` | behavioral suite (synthetic keys, fixture homes, mocked HTTP) |
