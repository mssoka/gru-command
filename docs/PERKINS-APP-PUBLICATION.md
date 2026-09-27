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

`config` is plain literal data — it is parsed as bytes, never evaluated or
sourced as a shell script, so `$HOME` in a value stays the literal string:

```
app_id=4366368
key_path="/absolute/path/to/app-key.pem"
installation_id_mssoka=164552969
installation_id_solarity-services=999888777
```

- `key_path` may be quoted or unquoted; relative paths resolve against
  `<instance_dir>/perkins/`.
- `installation_id_<owner>` is one entry per reviewed repository owner,
  including hyphenated organization names. Lookup is case-insensitive.
- The key must be the RSA PEM download from the App settings page.

## Mode selection (startup)

Selection is by bundle **presence**, checked once at service start:

| Bundle | github.com publication | Every other host |
|---|---|---|
| `<instance_dir>/perkins/config` exists | Perkins App poster | see boundary below |
| absent | legacy `gh` poster, byte-for-byte unchanged | legacy behavior |

Deployments with no bundle behave exactly as before. GitLab routing is
untouched in both modes.

With a bundle present, a non-github.com GitHub host (e.g. a GitHub
Enterprise instance) **fails closed**: the App's credentials are bound to
`api.github.com` and are never sent anywhere else, and no silent
personal-credential fallback exists. This is a deliberate compatibility
boundary — hosting App reviews on another host needs its own explicit
publisher decision.

## The identity chain (all before the irreversible POST)

1. PR URL + repository-origin validation, identical to the legacy poster.
2. Bundle load and validation (missing/invalid/inaccessible credentials
   fail closed with sanitized diagnostics — key bytes never appear in an
   error, and no personal credential is ever consulted).
3. A short-lived RS256 App JWT (`iss` = `app_id`, ≤ 10 minutes) mints an
   installation access token **down-scoped to the one repository and
   `pull_requests: write` (+ implicit metadata read)**.
4. The token grant is verified: pull-request write permission and
   repository coverage proven by the provider response.
5. `GET /app` proves the authenticated App is the configured `app_id`;
   its slug derives the expected bot identity `<slug>[bot]`.
6. The PR head must equal the round's frozen target SHA.
7. The review POST is `{body, event: "COMMENT", commit_id: <target>}`.
8. The response's real author must be the verified App bot
   (`<slug>[bot]`, `type: "Bot"`) on the exact `commit_id`.

Every request goes to a hard-coded `https://api.github.com` with redirects
refused; tokens never appear in URLs, logs, or error text. An installation
token is never used against `/user` — it is not a user token.

## Failures and ambiguous delivery

Token expiry, missing permission, suspended or mismatched installation,
identity mismatch: the round is recorded but NOT posted; the escalation is
actionable and sanitized. Nothing falls back to a personal `gh` identity.

If the review POST's outcome is unknown (network loss after send, 5xx), a
**bounded reconciliation** lists the PR's reviews and credits the delivery
only on provider proof: our App bot as author, `COMMENTED` state, the
exact frozen `commit_id`, and a byte-identical body. A foreign author with
the same bytes is never credited; an exhausted or failing lookup is never
treated as absence — the delivery stays explicitly unproven and the review
is never blindly re-posted.

Recovery across the publisher-identity change: a review attempt whose
original author cannot be proved (the historical personal-identity era)
stays unresolved rather than being re-attributed or duplicated. Prior
receipts and reports are preserved unchanged.

## Activation and live check (owner-controlled)

1. Land and deploy the approved code (owner merges; worker never merges).
2. Confirm the bundle exists under the *deployed instance dir* (it
   already does on the reference deployment; no App reinstall, no new
   permissions are required).
3. Restart the service (owner action).
4. Trigger one authorized review round; the delivered review must show
   **perkins-review[bot]** as the reviewer on the exact frozen head.
5. Until 3–4 are done, reviews are still posted by the deployed personal
   publisher — do not claim App activation before that.

## Where the code lives

| File | Role |
|---|---|
| `src/dispatch/perkins-github-app.ts` | bundle parsing, JWT, token mint, App poster, startup factory |
| `src/main.ts` | one-line poster injection at startup |
| `test/perkins-github-app.test.ts` | behavioral suite (synthetic keys, fixture homes, mocked HTTP) |
