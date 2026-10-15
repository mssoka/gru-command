# Gru Command BMAD runtime — notices

This runtime bundles files from **BMad Method** (`bmad-method` on npm,
<https://github.com/bmad-code-org/BMAD-METHOD>), redistributed under the MIT
License. The upstream license text ships unchanged as `LICENSE` next to this
notice. The exact upstream package version, registry tarball integrity, source
revision and per-file hashes are recorded in `runtime.json`.

Upstream files are redistributed byte-for-byte. The Gru Command customization
layer (`gru-command-bmad`, identified with its version in `runtime.json`) adds:

- `scripts/gc_render.py` — an entry point that runs the unchanged upstream
  renderer with Gru Command's configuration and customization layers;
- `skills/bmad-build/SKILL.md` — the upstream launcher with one line changed,
  so it calls that entry point instead of a repo-local `_bmad/scripts` install;
- `customize/bmad-build.toml` — a supported customization override of the
  Blind Hunter review layer (both build routes) without a finding quota;
- `config/defaults.toml` — default configuration for the bundled skills;
- `.claude-plugin/plugin.json` — the manifest Claude Code needs to load the
  bundled skills as a plugin.

TRADEMARK NOTICE (from the upstream license): BMad™, BMad Method™, and BMad
Core™ are trademarks of BMad Code, LLC, covering all casings and variations
(including BMAD, bmad, BMadMethod, BMAD-METHOD, etc.). Their use here does not
grant any rights to use the trademarks for any other purpose. The upstream
license refers to `CONTRIBUTORS.md` and `TRADEMARK.md`, which are published in
the upstream repository at the recorded source revision.

Gru Command itself is MIT-licensed; see the repository `LICENSE`.
