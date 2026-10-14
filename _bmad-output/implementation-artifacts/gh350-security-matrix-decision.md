# GH350 — security-matrix owner decision and evidence

Status: **owner clarification received; security acceptance and integration resumed**. Full-green / PR / READY gates still require fresh evidence.

## Owner decision (relayed by `wAJ:p1`, 2026-10-14)

> A parser PASS is acceptable ONLY as an unqualified report. Product qualification is granted solely by the known-bad and healthy host qualification, which must reject fake/vacuous evidence (including hostile runners that catch EPERM and print PASS). No new per-operation host audit design. Keep the Seatbelt deny-default profile, keep your raw-parser test (it documents the distinction), add a known-bad fake-runner case to the qualification controls proving it is rejected, and record this decision in the evidence file and PR description. Do not ship fatal-denial modes that break legitimate Node/Tinypool probes. Resume security acceptance and continue to integration.

Implementation follows this interpretation without changing the frozen spec block:

- The retained executor test now documents the permitted raw `runner-report-classification` PASS, verifies the host read was denied, and makes no product-proof claim.
- A new production-campaign control runs the hostile fake runner against actual known-bad and healthy repositories through host-issued executor evidence. Both raw reports say PASS; host qualification must reject them as `rejected-vacuous`, with no candidate evidence, frozen contract, repair, blocker, or merge authority.
- The deny-default profile remains in force. There is no per-operation audit claim and no fatal-denial mode or CPU-probe shim.
- The decision must be included in the draft PR description. Fresh checks follow; historical logs below are not retroactively green.

## Current boundary

- Branch: `feat/350-stack-aware-property-contracts`; committed HEAD `1b8247e3eb1e7e216ec148f4bd00c530c2e656fb`, plus substantial uncommitted integration work.
- Operator's latest publication prerequisite: merge current `origin/main` (including PR344's `a04a3c75`), preserve both sides' intent, then obtain **Full suite (Node 22)** green at the exact published merged head. This has **not** been performed or claimed.
- Spec remains `in-progress`. Its frozen matrix is unchanged. Publication/review workflow has not advanced.
- No worker recovery, new delegation, provider change, dependency install, or unsandboxed fallback occurred.

## Observed facts before the owner clarification

1. The deny-default macOS profile denies arbitrary host-file reads, disk writes (including within the copied workspace), network access, and process forks. Owned canaries verify those denials; process close and empty owned group precede cleanup.
2. Denied syscalls normally return `EPERM`/`EACCES`. A hostile **fake unit runner** can catch a denied read and print a JSON PASS report. That produces a **runner-report parser classification**, not qualified product evidence. No file contents escaped.
3. A newly added executor control originally expected this caught-denial case to produce `infrastructure-error`/`SIGKILL` and failed. That historical red is preserved below. Only after the explicit owner interpretation above was the retained test corrected to document parser classification rather than invent a fatal-product boundary.
4. Experiments making denied I/O/network/fork fatal also killed legitimate runtime startup. Trusted, fixed-code probes identified CoreFoundation's real-home text-encoding probe and Tinypool's literal `sysctl -n hw.physicalcpu_max` shell probe. The latter is denied by the OS and handled by Tinypool under the nonfatal policy.
5. The fatal-policy and diagnostic preload experiments were removed from the working implementation. No additional public-file guesses, socket grants, compatibility command shims, or diagnostic hooks remain in the shipped path. Existing denials remain enforced.
6. Host-owned `CFFIXED_USER_HOME` and correctly hexadecimal-UID-prefixed `__CF_USER_TEXT_ENCODING` avoid the CoreFoundation real-home probe. The volatile isolated home is excluded from the environment comparison, like `HOME`/`TMPDIR`; the stable encoding value is retained.

## Decision requested from the operator

The frozen row says: **violation attempt ⇒ sandbox denies; receipt records the violation class; never a product PASS**. Elsewhere the same frozen contract explicitly distinguishes parser classifications from qualified product proof.

- Does the row require unforgeable **per-operation** auditing and automatic rejection even when an OS denial is caught? If so, the present backend does not establish that guarantee; additional host-auditing design/implementation/qualification is needed. Neither catchable JS instrumentation nor blanket fatal denials that kill healthy startup satisfy it.
- Or may a caught denial result in an explicitly **unqualified parser report**, provided it can never itself become product proof and production known-bad/healthy qualification rejects vacuous/fabricated controls? If this is the intended boundary, the raw-parser test needs correction with an explicit operator interpretation and a production-qualification regression; not an undocumented expectation change.

The clarification prompt was accepted by `herdr agent prompt wAJ:p1`; acceptance is not proof it was read or answered. A subsequent scoped-verification update was **not delivered**: Herdr returned `agent_blocked` / `agent wAJ:p1 is blocked and requires interactive input` (command exit 1). That communication path is stopped; no retry, alternate input method, or owner-prompt approval was attempted. This historical pause ended when the owner decision above was relayed; no alternate input method or owner-prompt approval was used.

## Last scoped verification before the decision (dirty inputs, not exact-head acceptance)

- Node `v22.22.0`.
- Typecheck: passed, `gh350-current-types.log`.
- Focused ESLint: passed, `gh350-current-lint.log`.
- FAST property/resolver/adapter/config/qualification/metrics/catalog/suite-shape: **102/102 passed** across eight files; `gh350-current-fast.log`.
- Six property HEAVY files: **63/64 passed**, one caught-denial raw-parser control failed; `gh350-current-heavy.log`.
- Both real Vitest+fast-check campaign cases passed in that HEAVY run. The first covers actual shrinking, qualification, seed/path replay, production Perkins READY refusal, bounded implementation repair through the existing router, frozen-oracle verification, reviewed regression retention, and execution of the retained regression. The second rejects an actually vacuous oracle.
- Fake runner suites remain unit/OS controls; stateful models remain simulated evidence. Neither substitutes for the real campaign.
- Collection pins corrected to executor **22**, qualification **29**. `git diff --check` passed.
- No current full `npm test`, fresh whole-change independent review, clean exact-head gate, main integration, push, draft PR, or remote CI acceptance.

## Custody

`/Users/moses/.gru-command/captures/issue-350-perkins-property-contracts/security-matrix-decision-20261014T193503Z/`

- 64 captured files, including the current tracked+untracked primary patch, status, diagnostic profiles, raw logs, real-run receipts, and counterexample artifacts.
- `manifest.json` SHA256: `570684bfff2c8a4ad658ab530e48f2af9bfb7385e0b114736e5d919a81be65fe`.
- Historical fatal-policy passes and diagnostic nonfatal runs are **not** acceptance evidence for the current input.

## Sources

- [Mark Rowe — Sandboxing on macOS](https://bdash.net.nz/posts/sandboxing-on-macos/): default denial returns `EPERM`; action modifiers alter denial behavior. This contextual source does not replace the actual OS controls above.
