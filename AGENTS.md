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

## Review notes

- `resources/perkins-code-review/policy.json` is integrity-pinned; after
  editing it (or `src/runtime/review-mcp-server.mjs`), refresh the pins in
  `src/dispatch/perkins-review/policy.ts`,
  `src/runtime/review-mcp-bridge.ts`, and `tools/verify-perkins-resource.mjs`.
- `npm pack` runs `prepack` (clean + rebuild backend and web) and the build
  runs `node tools/verify-perkins-resource.mjs .` — a failing verifier fails
  the build.
