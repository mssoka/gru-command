# Prior native findings and individual dispositions (Perkins r1, PR #148)

Source: native Perkins whole-PR round `wizard-bmad-deterministic-retry-32-r1`,
verdict **NEEDS CHANGES**, target `2bf6bc7cf939c3dc41e90cfb5f3193f9529608aa`,
diff base `2aa836abe262759c651683deb40d05f02c9ede86` (published as a COMMENT
review on PR #148; full text in `native-r1-review.md`). Three blockers and one
warning. Every finding is dispositioned below against the current head; none
is deferred or disputed.

## Blocker 1 — deleted recorded runtime bindings still offer futile retry

- **Finding (r1):** after a successful onboard, deleting `.agents/skills/bmad-build`
  and requesting reuse made `realpathSync` throw a native ENOENT before the named
  validation error; the catch left `deterministic` undefined and the wizard
  offered retry against unchanged state.
- **Disposition: fixed.**
- **Repair:** `validatedSkillPath()` classifies realpath ENOENT/ENOTDIR on a
  recorded binding/root as a deterministic `BmadDeterministicSetupError` with
  the installer hint ("BMAD recorded skill binding is missing"); every other
  errno rethrows as transient — no blanket catch. See
  `src/wizard/bmad-onboarding.ts:614` and the deterministic shape at `:594`.
- **Regressions:** `test/bmad-onboarding.test.ts:1033` (unit),
  `test/wizard.test.ts:493` (noninteractive: successful synthetic install →
  delete recorded binding → reuse → exit 1 skip-only with the installer hint),
  `test/wizard-interactive.test.ts:312` (pty: typed retry refused, only skip
  completes).

## Blocker 2 — previously onboarded module failures lose the installer repair hint

- **Finding (r1):** with a Gru record present, fingerprint verification ran
  before declared-module verification, so a deleted `_bmad/tea` (or a symlinked
  module) produced a deterministic error WITHOUT the required
  `npx bmad-method install` hint.
- **Disposition: fixed.**
- **Repair:** reuse validates declared module directories via
  `verifyModuleDirectories(existing.summary)` BEFORE record/fingerprint work
  (`src/wizard/bmad-onboarding.ts:547`, definition `:360`); fingerprint
  protection itself is unchanged, and the now-redundant post-hash call was
  removed.
- **Regressions:** `test/bmad-onboarding.test.ts:982` (missing module) and
  `:1009` (symlinked module) assert the installer hint before any fingerprint
  refusal.

## Blocker 3 — control-file read failures incorrectly become skip-only

- **Finding (r1):** `readFileSync` and `JSON.parse` shared one catch, so a
  valid-but-unreadable record/manifest became "malformed" and skip-only; the
  useful retry after restoring permissions was denied.
- **Disposition: fixed.**
- **Repair:** `assertControlFilesSafe` performs the reads OUTSIDE their parse
  catches, so a filesystem read error stays transient while a parse failure
  remains deterministic (no blanket catch).
- **Regression:** `test/bmad-onboarding.test.ts:1055` — valid-but-unreadable
  control files stay transient and recover on the SAME collected answers
  object, with permissions restored in `finally`.

## Warning — disposable preflight-output validation incorrectly disables retry

- **Finding (r1):** the symlinked-skill refusal inside `installFresh`'s
  disposable staging step forced skip-only even though the stage is deleted in
  `finally` and the repo is unchanged.
- **Disposition: fixed.**
- **Repair:** `preflightSkillNames()` (`src/wizard/bmad-onboarding.ts:483`)
  keeps the safety refusal text while classifying the disposable stage as
  transient; existing-repo validation stays deterministic.
- **Regression:** `test/bmad-onboarding.test.ts:1102` — a stateful
  failing-stage-then-successful-stage fixture proves the next attempt completes.

## Verification of the dispositions at the current product head

The lane spec's continuation notes record the repair commits
(`b13b6eb`, `5f61593`, plus the browser-correction commits below), and the
current evidence (`verification/current-evidence.md`) binds the scoped runs
that execute every regression above: `wizard-bmad-retry` focused (58/58), the
`full` chain (backend 1783 passed / 12 skipped; web 409), and the
browser-consumer run (web unit 409/409; Playwright 51/51). The r1 round is
`verdict-posted` and no re-review of its dispositions was requested by the
owner; a fresh whole-change review is what this packet serves.

## Browser-correction changes after r1 (context for this review)

The r1 round predates the browser-consumer correction. Its changes
(`web/mock/server.ts`, `web/e2e/*.spec.ts`, `web/src/styles/components.css`,
`web/src/ui/chat-working-flavor.test.ts`, four regenerated darwin baselines)
are fully in this packet's `final.patch`, described in
`repair-lineage/lineage.md` and `png/PROVENANCE.md`, and are exactly the part
of the change the r1 round could not have seen.
