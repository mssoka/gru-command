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

- The tree carries the version of the **next** release. Bump `package.json`
  (and the lock) when a release cycle starts, not after tagging; cutting
  the release tags a commit whose `package.json` already equals the tag.
  The tag-triggered `.github/workflows/release.yml` runs
  `node tools/verify-release-version.mjs "$GITHUB_REF_NAME"`, publishes a
  GitHub Release with generated notes, and fails on a mismatch.
  Prerelease tags are skipped, not failed.
- `/health` reports the version the running process loaded; `gru version`
  takes it from the build stamp, so a pull without a rebuild
  cannot claim a version it never shipped. The board's deploy chip names
  the newest **tagged** release; on main those differ by design. v1.0.1 is
  the known historical mismatch (its commit says 1.0.0); it is not
  re-tagged.
- The deploy chip advertises only releases reachable from `origin/main`
  (the update path pulls main) and only when the running build does not
  already contain that release; a tag on another ref is noted as not
  advertised, never used to nag. Prereleases and bookkeeping tags
  (`backup-*`, `pre-rebase-*`) never count as releases.
- The update itself is always the same path: `gru update` (the deploy
  clone's `./install.sh --update`), the one-liner, or `gru roll`. All pull
  `main`; a tag names a snapshot, it does not pin an instance. `gru` is the
  launcher `install.sh` writes to `~/.local/bin`; `gru-service` is its
  older name.

## Review notes

- `resources/perkins-code-review/policy.json` is integrity-pinned; after
  editing it (or `src/runtime/review-mcp-server.mjs`), refresh the pins in
  `src/dispatch/perkins-review/policy.ts`,
  `src/runtime/review-mcp-bridge.ts`, and `tools/verify-perkins-resource.mjs`.
- `npm pack` runs `prepack` (clean + rebuild backend and web) and the build
  runs `node tools/verify-perkins-resource.mjs .` — a failing verifier fails
  the build.
