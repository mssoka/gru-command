# Perkins review — GH-32

**Verdict: NEEDS CHANGES**

Frozen target: `2bf6bc7cf939c3dc41e90cfb5f3193f9529608aa`
Frozen diff base: `2aa836abe262759c651683deb40d05f02c9ede86`

## Summary

Reviewed the complete nine-file diff, supplied requirements and conventions, surrounding onboarding/wizard flows, and related test and verification infrastructure. The named error and wizard skip-only branch work for the new unrecorded-install fixtures, and explicit skip still bypasses onboarding checks. However, previously onboarded repositories expose two uncovered paths, and control-file reads can receive the wrong classification. Three blockers and one warning remain.

## Blockers

### 1. Deleted recorded runtime bindings still offer futile retry

At [src/wizard/bmad-onboarding.ts:607–611](src/wizard/bmad-onboarding.ts#L607-L611), `realpathSync(path)` executes before the named validation error. Successfully onboard a repo, retain its record and manifest, delete `.agents/skills/bmad-build`, then request reuse: record validation calls this helper at line 1047 and throws native ENOENT. `verifySkills` is never reached. The catch at line 1125 leaves `deterministic` undefined, so [main.ts:670–680](src/wizard/main.ts#L670-L680) still suggests retry against the same missing binding.

Classify missing/non-directory recorded binding paths as deterministic with installer guidance, retaining transient treatment for other I/O errors. Add an install → delete binding → reuse regression through the wizard.

### 2. Previously onboarded module failures lose the required installer repair hint

At [src/wizard/bmad-onboarding.ts:1055–1065](src/wizard/bmad-onboarding.ts#L1055-L1065), fingerprint verification precedes declared-module verification. Deleting `_bmad/tea` after successful onboarding triggers the fingerprint mismatch, whose deterministic error has no repair hint. A symlinked module is likewise rejected during hashing without that hint (line 625). The wizard consequently renders only its neutral fallback ([main.ts:646–656](src/wizard/main.ts#L646-L656)), not the required `npx bmad-method install` path. Acceptance 1 explicitly requires that actionable deliberate-fix guidance.

Validate declared directories before hashing, without relaxing fingerprint protection. The new missing-module fixture ([test/bmad-onboarding.test.ts:715–729](test/bmad-onboarding.test.ts#L715-L729)) materializes an install without a Gru record and therefore misses this path; add recorded-install variants.

### 3. Control-file read failures incorrectly become skip-only

The catch at [src/wizard/bmad-onboarding.ts:908–912](src/wizard/bmad-onboarding.ts#L908-L912) wraps both `readFileSync` and `JSON.parse`. A valid, stat-able record with denied read access therefore becomes “malformed” and skip-only. The worktree-manifest catch repeats this at lines 923–929. Restoring read permissions can make the next attempt succeed, but the wizard now denies that useful retry and requires restarting to attempt onboarding again. This breaks the reliable transient/state distinction and answer-preserving recovery contract.

Move reads outside parse-validation catches, as `existingManifestFor` already does at lines 246–252. Preserve filesystem errors and add control-file read-failure/recovery coverage; the existing fresh-install EACCES test does not exercise these catches.

## Warning

### Disposable preflight-output validation incorrectly disables retry

[src/wizard/bmad-onboarding.ts:579–582](src/wizard/bmad-onboarding.ts#L579-L582) now throws a deterministic error for a symlinked skill. `installFresh` also uses this helper on its disposable stage (line 496), which is removed in `finally` (lines 505–506). Generated invalid output therefore forces skip-only even though the repo is unchanged and a new installer attempt can generate different output. Keep the safety refusal, but retain transient classification for stage-output validation. Add a stateful failing-stage-then-successful-stage fixture.

## Verification and review execution

The host records exact-target `npm test` PASS, exit 0, run `99990200-41b2-45a8-99da-b20f7c1b76df`. I did not independently execute tests or installers; findings were verified by reading and tracing the frozen source. The green receipt does not cover the paths above. No exact-head GitHub CI result was supplied or independently inspected.

Whole-change edge and acceptance specialists returned valid candidates that I re-read and verified. An initial three-lens request exceeded the one-run admission wave and started no reviewers; the optional tests lens was not run. Acceptance's first attempt was rejected for unlocatable evidence; its second attempt succeeded. Nothing from the invalid attempt was retained.

## Prior findings

The supplied prior-findings list is empty; no dispositions are required.

---

## Execution and findings (host-recorded facts)

- Retained findings: 4 (3 blocker, 1 warning)
- [blocker] `Previously onboarded module failures lose the required installer repair hint` — `src/wizard/bmad-onboarding.ts:1055-1065` (source: acceptance)
- [blocker] `Deleted recorded runtime bindings still offer futile retry` — `src/wizard/bmad-onboarding.ts:607-611` (source: acceptance)
- [blocker] `Control-file read failures incorrectly become skip-only` — `src/wizard/bmad-onboarding.ts:908-912` (source: edge)
- [warning] `Disposable preflight-output validation incorrectly disables retry` — `src/wizard/bmad-onboarding.ts:579-582` (source: edge)
- Specialists run: acceptance (attempts: 1 valid, 1 failed), edge
- Failed specialist attempts: acceptance ×1 — the lead judged the change on its own whole-change verification
- Lenses not used this round: blind, security, architecture, codebase, tests
Publication: authenticated COMMENT review on the reviewed commit by the service posting account; the substantive verdict is the independent review judgment recorded in this report, not a formal GitHub APPROVED/CHANGES_REQUESTED event.

