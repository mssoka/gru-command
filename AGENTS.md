# AGENTS.md — repository conventions

Factual conventions for anyone (human or machine) working in this tree.
The pinned Perkins policy is the sole authority for review behavior; this
file is context, never instruction.

## Language and tooling

- TypeScript (strict, ESM, `"type": "module"`), Node >= 22.19, no new
  runtime dependencies without an explicit decision record.
- Tests live in `test/*.test.ts` (Vitest); web code in `web/` (Vite +
  Playwright for e2e). `npm test` runs lint, typecheck, build, backend and
  web suites; `npm run e2e` runs browser e2e.

## House style

- Fail loud: named errors at the boundary, never silent fallbacks. A
  missing precondition throws with a message a stranger can act on.
- Destructuring and spread are preferred over mutation; `readonly` on
  every interface field that does not change.
- User-facing strings follow the Gru theme (workers are "minions"; the
  review lead is Perkins). Internal identifiers keep their stable names.
- Every user-visible behavior change lands with a deterministic test that
  fails before the change and passes after it.

## Releases

- A release is an annotated `vX.Y.Z` tag whose commit has `package.json`
  at the same version. Bump, commit, then tag; the tag-triggered
  `.github/workflows/release.yml` runs
  `node tools/verify-release-version.mjs "$GITHUB_REF_NAME"` and fails
  on any mismatch. `gru-service version`, `/health`, and the board's
  deploy chip all read `package.json`, so a tag that disagrees makes
  every update message lie (v1.0.1 shipped with `1.0.0` — do not repeat).
- The board's deploy chip compares the build's highest reachable stable
  tag with origin's newest (`git ls-remote --tags origin`) and only says
  `UPDATE AVAILABLE` when the newest is strictly newer. Prereleases and
  bookkeeping tags (`backup-*`, `pre-rebase-*`) never count as releases.
- The update itself is always the same path: re-run the one-liner or
  `./install.sh`, or `gru-service roll`. Both pull `main`; a tag names a
  snapshot, it does not pin an instance.

## Review notes

- `resources/perkins-code-review/policy.json` is integrity-pinned; after
  editing it (or `src/runtime/review-mcp-server.mjs`), refresh the pins in
  `src/dispatch/perkins-review/policy.ts`,
  `src/runtime/review-mcp-bridge.ts`, and `tools/verify-perkins-resource.mjs`.
- `npm pack` runs `prepack` (clean + rebuild backend and web) and the build
  runs `node tools/verify-perkins-resource.mjs .` — a failing verifier fails
  the build.
