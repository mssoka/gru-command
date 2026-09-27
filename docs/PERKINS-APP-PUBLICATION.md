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
(default `~/.gru-command/`), never inside a repository checkout:

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
  `<instance_dir>/perkins/` (but is not confined to it — `..` segments are
  permitted), and an absolute path is permitted. Wherever the key lives,
  it passes the same file-level checks; the bundle dir remains the audit
  boundary — the config that names the key still lives there.
- `installation_id_<owner>` takes one entry per reviewed repository owner,
  including hyphenated organization names. Lookup is case-insensitive.
- The key must be the RSA PEM downloaded from the App settings page.
- Both files must be regular files owned by the service user, readable by
  the owner and by nobody else (0600 recommended — a hardened 0400 key is
  fine), with no setuid/setgid/sticky bits, and `<instance_dir>/perkins`
  itself must be an owner-owned 0700 directory. Publication time enforces
  all of this — including rejecting symlinked files — and fails closed,
  naming the found mode in the message. (Windows deployments: ownership
  and mode enforcement is not applied and symlink rejection is best-effort
  (an lstat check without `O_NOFOLLOW` backstop) — restrict the bundle
  with filesystem ACLs.)
- The bundle is provisioned by the owner (App settings + installation);
  the service only reads it.

## Mode selection (startup)

Selection is by bundle **presence**, checked once at service start. Any
bundle-shaped presence — a regular file, a symlink, a directory, even an
unreadable path — selects App mode: **for selection**, presence is
presence; a broken bundle then fails loudly at publication time and never
silently degrades to a personal credential. Bundle problems surface at
publication time, never at boot:

| Bundle | github.com publication |
|---|---|
| `<instance_dir>/perkins/config` present | Perkins App poster |
| absent | legacy `gh` poster, byte-for-byte unchanged |

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
2. Bundle load and validation — both files owner-owned 0600 regular files;
   missing/invalid/inaccessible credentials fail closed with sanitized
   diagnostics — key bytes never appear in an error, and no personal
   credential is ever consulted.
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
- submitted at or after this round's POST began (a 60 s clock-skew
  margin) — an older round's identical bytes are never credited.

A foreign author with the same bytes is never credited; an exhausted or
failing lookup is never treated as absence — the delivery stays explicitly
unproven and the review is never blindly re-posted.

**Runbook for an unproven delivery.** Open the pull request's reviews. A
COMMENT review authored by `<slug>[bot]` (for this App:
`perkins-review[bot]`) on the exact frozen head that matches the body the
round published — and whose submission time falls within this round —
means it landed: record the receipt manually per the escalation (the
escalation names the expected bot login and head). Otherwise it was not
delivered, and a retry on a **new** frozen head is safe; re-running
against the same head without checking first is what duplicates reviews.

Recovery across the publisher-identity change: a review attempt whose
original author cannot be proved (the historical personal-identity era)
stays unresolved rather than being re-attributed or duplicated. Prior
receipts and reports are preserved unchanged.

## Activation and live check (owner-controlled)

1. Land and deploy the approved code (owner merges; worker never merges).
2. Confirm the bundle exists under the *deployed instance dir* (it
   already does on the owner's production deployment; no App reinstall, no
   new permissions are required).
3. Restart the service (owner action).
4. Trigger one authorized review round; the delivered review must show
   **`perkins-review[bot]`** as the reviewer on the exact frozen head.

Until 3–4 are done, reviews are still posted by the deployed personal
publisher — do not claim App activation before that.

## Where the code lives

| File | Role |
|---|---|
| `src/dispatch/perkins-github-app.ts` | bundle parsing, JWT, token mint, App poster, startup factory |
| `src/main.ts` | one-line poster injection at startup (`createStartupVerdictPoster`) |
| `test/perkins-github-app.test.ts` | behavioral suite (synthetic keys, fixture homes, mocked HTTP) |
