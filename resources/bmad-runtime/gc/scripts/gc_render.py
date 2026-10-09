#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Gru Command entry point for the bundled BMAD renderer.

The upstream renderer (render_skill.py, unchanged) expects a repo-local
`_bmad/` framework install. This entry keeps the upstream rendering code and
replaces only where configuration is read from, so a managed repository needs
no framework files of its own:

Central configuration (later layers win):
  1. <runtime>/config/defaults.toml            (Gru Command runtime defaults)
  2. {project-root}/_bmad/custom/config.toml       (project, team)
  3. {project-root}/_bmad/custom/config.user.toml  (project, personal)

Skill customization (later layers win):
  1. <runtime>/skills/<skill>/customize.toml       (upstream defaults)
  2. <runtime>/customize/<skill>.toml              (Gru Command layer)
  3. {project-root}/_bmad/custom/<skill>.toml      (project, team)
  4. {project-root}/_bmad/custom/<skill>.user.toml (project, personal)

Rendered snapshots are written to {project-root}/_bmad/render/ exactly as the
upstream renderer does; that directory ignores itself in git. The runtime
directory is never written.
"""

from __future__ import annotations

import sys

# Installed runtime files are immutable; never write interpreter caches there.
sys.dont_write_bytecode = True

import argparse  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import config_utils  # noqa: E402
import render_skill  # noqa: E402

RUNTIME_ROOT = Path(__file__).resolve().parent.parent
RENDER_IGNORE = (
    "# Rendered BMAD workflow snapshots (derived output of the Gru Command\n"
    "# BMAD runtime). Never commit them.\n"
    "*\n"
)
# Legacy repo-local installer answers that the bundled runtime no longer reads.
LEGACY_CONFIG_FILES = ("config.toml", "config.user.toml")


class ProjectStateError(ValueError):
    """Raised when the project's BMAD state cannot be used safely."""


def _no_symlink(path: Path) -> None:
    if path.is_symlink():
        raise ProjectStateError(
            f"{path} is a symlink; the Gru Command BMAD runtime keeps project state "
            "inside this checkout only. Replace the link with a real directory "
            "(copy _bmad/custom/ into it when you need those settings)."
        )


def ensure_render_root(project_root: Path) -> None:
    """Create the project-local render location; refuse links out of the project."""
    bmad_dir = project_root / "_bmad"
    _no_symlink(bmad_dir)
    if bmad_dir.exists() and not bmad_dir.is_dir():
        raise ProjectStateError(f"{bmad_dir} exists but is not a directory")
    render_dir = bmad_dir / "render"
    _no_symlink(render_dir)
    render_dir.mkdir(parents=True, exist_ok=True)
    ignore = render_dir / ".gitignore"
    _no_symlink(ignore)
    if not ignore.exists():
        ignore.write_text(RENDER_IGNORE, encoding="utf-8")


def load_central_config(project_root: Path) -> dict[str, Any]:
    custom_dir = project_root / "_bmad" / "custom"
    return config_utils.merge_layers(
        (
            config_utils.load_toml(RUNTIME_ROOT / "config" / "defaults.toml", required=True),
            config_utils.load_toml(custom_dir / "config.toml"),
            config_utils.load_toml(custom_dir / "config.user.toml"),
        )
    )


def load_customization(project_root: Path | None, skill_dir: Path) -> dict[str, Any]:
    skill_name = skill_dir.name
    custom_dir = project_root / "_bmad" / "custom" if project_root else None
    return config_utils.merge_layers(
        (
            config_utils.load_toml(skill_dir / "customize.toml", required=True),
            config_utils.load_toml(RUNTIME_ROOT / "customize" / f"{skill_name}.toml"),
            config_utils.load_toml(custom_dir / f"{skill_name}.toml") if custom_dir else {},
            config_utils.load_toml(custom_dir / f"{skill_name}.user.toml") if custom_dir else {},
        )
    )


def _scalars(data: Any, prefix: str = "") -> dict[str, Any]:
    found: dict[str, Any] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, dict):
                found.update(_scalars(value, path))
            elif not isinstance(value, list):
                found[path] = value
    return found


def check_legacy_answers(project_root: Path, effective: dict[str, Any]) -> None:
    """Refuse to silently drop a legacy installer answer the runtime would use.

    A repo-local install kept its answers in _bmad/config.toml and
    _bmad/config.user.toml. The bundled runtime reads _bmad/custom/ instead;
    when a legacy answer for a setting the runtime resolves differs from the
    effective value, rendering stops until the owner moves that setting.
    """
    resolved = _scalars(effective)
    for name in LEGACY_CONFIG_FILES:
        path = project_root / "_bmad" / name
        if not path.is_file():
            continue
        for key, value in _scalars(config_utils.load_toml(path)).items():
            if key in resolved and resolved[key] != value:
                raise ProjectStateError(
                    f"legacy BMAD installer answer `{key}` = {value!r} in {path} differs from the "
                    f"effective value {resolved[key]!r}. The Gru Command BMAD runtime does not read "
                    "installer answers; move the setting to _bmad/custom/config.toml (team) or "
                    "_bmad/custom/config.user.toml (personal) — see docs/BMAD-RUNTIME.md."
                )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--skill", required=True)
    args = parser.parse_args()
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8")
    try:
        project_root = Path(args.project_root).resolve(strict=True)
        skill_dir = Path(args.skill).resolve(strict=True)
        if skill_dir.parent != RUNTIME_ROOT / "skills":
            raise ProjectStateError(
                f"skill {skill_dir} is not part of this Gru Command BMAD runtime ({RUNTIME_ROOT})"
            )
        check_legacy_answers(project_root, load_central_config(project_root))
        ensure_render_root(project_root)
        render_skill.load_central_config = load_central_config
        render_skill.load_customization = load_customization
        entry = render_skill.render(project_root, skill_dir)
    except (
        config_utils.ConfigError,
        render_skill.RenderError,
        ProjectStateError,
        OSError,
        UnicodeError,
        ValueError,
    ) as error:
        sys.stdout.write(f"HALT: {error}\n")
        return 1
    sys.stdout.write(f"read and follow {entry}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
