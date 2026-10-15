# GH350 real-tool fixture provisioning record

Root-approved 2026-10-14 with bounded guards. The fixture-decision and
admission-approval record is retained in the owner's external coordination
captures; machine-specific paths do not ship.
Test-only infrastructure: this fixture is never a Gru runtime or dev
dependency, ships no installer capability, and touches no other lane.

## Locked toolchain identity (committed)

| Package | Exact resolved version | Source |
|---------|----------------------|--------|
| vitest | 3.2.7 | public npm registry (sha512 integrity) |
| fast-check | 3.23.2 | public npm registry (sha512 integrity) |

`package-lock.json` (104 entries, lockfileVersion 3) is the identity of
record: every entry resolves against `https://registry.npmjs.org/` with
sha512 integrity (enforced by `tools/provision-property-real-fixture.mjs`).
The manifest ranges (`vitest ~3.2.7`, `fast-check ^3`) were inputs to the
ONE initial resolution only — never execution identity.

## Provisioning stages (each run exactly once, 2026-10-14)

Declared before execution in `.provisioning/<stage>/record.json` (gitignored,
machine-local): installer argv, Node/npm identities, canonical cwd,
environment policy, registry endpoint, expected result, output paths and
limits. Direct exit codes, signals, timings and stream hashes are preserved
in `.provisioning/<stage>/outcome.json` with separate stdout/stderr files.

1. **resolve** — `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/` — exit 0; lock sha256 `2145440288291a57865cacdc8b65b46545d2c063da77a99ce62f1733fd9795c9`.
2. **materialize** — `npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/` — exit 0; installed toolchain validated against the committed lock (vitest@3.2.7 entrypoint runs; fast-check@3.23.2 imports with `assert`/`sample`).

Guards: public registry only (git/URL/path substitutions rejected by lock
scan); dependency lifecycle scripts, audit, funding and update-notifier
disabled; owned isolated HOME/config/cache/temp under `.provisioning/`;
allowlist-only environment (no credential variables); canonical-containment
and no-symlink destination checks; refusal on unexpected existing state;
failures STOP with evidence — no retry, cleanup or fallback.

## Reproduction (fresh checkout / CI)

```
node tools/provision-property-real-fixture.mjs materialize
```

The committed lock is the only input; `npm ci` fails on manifest/lock
mismatch and never updates dependencies implicitly. Network is authorized
ONLY for this declared provisioning stage — never for generated-test
execution. The real campaign (`test/property-real-tool-campaign.test.ts`)
requires this materialized toolchain AND a genuinely supported qualified
sandbox backend; missing tooling fails setup rather than skipping GREEN.
