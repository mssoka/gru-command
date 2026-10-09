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
upstream renderer does; that directory ignores itself in git. Configured
output folders inside the project are created on demand. Project state is
never read or written through a symlink, and the runtime directory is never
written.
"""

from __future__ import annotations

import sys

# Installed runtime files are immutable; never write interpreter caches there.
sys.dont_write_bytecode = True

import argparse  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
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
# Output locations created on demand when they resolve inside the project.
OUTPUT_SETTINGS = (
    ("core", "output_folder"),
    ("modules", "bmm", "planning_artifacts"),
    ("modules", "bmm", "implementation_artifacts"),
)


class ProjectStateError(ValueError):
    """Raised when the project's BMAD state cannot be used safely."""


def _no_symlink(path: Path) -> None:
    if path.is_symlink():
        raise ProjectStateError(
            f"{path} is a symlink; the Gru Command BMAD runtime keeps project state "
            "inside this checkout only. Replace the link with a real directory "
            "(copy _bmad/custom/ into it when you need those settings)."
        )


def _no_symlink_below(root: Path, target: Path) -> None:
    """Refuse a symlink in any component from `root` (exclusive) down to `target`."""
    current = root
    for part in target.relative_to(root).parts:
        current = current / part
        _no_symlink(current)


def _no_symlink_in_tree(root: Path) -> None:
    """Refuse a symlink at or anywhere below `root`."""
    _no_symlink(root)
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        for name in (*dirnames, *filenames):
            _no_symlink(Path(dirpath) / name)


def _custom_layer(project_root: Path, name: str) -> dict[str, Any]:
    """Load one project layer from _bmad/custom/, never through a link."""
    custom_dir = project_root / "_bmad" / "custom"
    _no_symlink_below(project_root, custom_dir / name)
    if custom_dir.exists() and not custom_dir.is_dir():
        raise ProjectStateError(f"{custom_dir} exists but is not a directory")
    return config_utils.load_toml(custom_dir / name)


def load_central_config(project_root: Path) -> dict[str, Any]:
    return config_utils.merge_layers(
        (
            config_utils.load_toml(RUNTIME_ROOT / "config" / "defaults.toml", required=True),
            _custom_layer(project_root, "config.toml"),
            _custom_layer(project_root, "config.user.toml"),
        )
    )


def load_customization(project_root: Path | None, skill_dir: Path) -> dict[str, Any]:
    skill_name = skill_dir.name
    return config_utils.merge_layers(
        (
            config_utils.load_toml(skill_dir / "customize.toml", required=True),
            config_utils.load_toml(RUNTIME_ROOT / "customize" / f"{skill_name}.toml"),
            _custom_layer(project_root, f"{skill_name}.toml") if project_root else {},
            _custom_layer(project_root, f"{skill_name}.user.toml") if project_root else {},
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
    _bmad/config.user.toml (the personal file wins). The bundled runtime reads
    _bmad/custom/ instead; when the legacy answer for a setting the runtime
    resolves differs from the effective value, rendering stops until the owner
    moves that setting.
    """
    layers = []
    for name in LEGACY_CONFIG_FILES:
        path = project_root / "_bmad" / name
        _no_symlink_below(project_root, path)
        if path.exists() and not path.is_file():
            raise ProjectStateError(f"{path} exists but is not a file")
        if path.is_file():
            layers.append(config_utils.load_toml(path))
    legacy = _scalars(config_utils.merge_layers(layers))
    resolved = _scalars(effective)
    for key, value in legacy.items():
        if key in resolved and resolved[key] != value:
            raise ProjectStateError(
                f"legacy BMAD installer answer `{key}` = {value!r} in {project_root / '_bmad'} differs from "
                f"the effective value {resolved[key]!r}. The Gru Command BMAD runtime does not read "
                "installer answers; move the setting to _bmad/custom/config.toml (team) or "
                "_bmad/custom/config.user.toml (personal) — see docs/BMAD-RUNTIME.md."
            )


def ensure_render_root(project_root: Path, skill_name: str) -> None:
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
    else:
        _assert_render_ignored(project_root, skill_name)
    # The upstream publisher writes below render/<skill>/; a link anywhere
    # there would carry snapshots out of this checkout.
    _no_symlink_in_tree(render_dir / skill_name)
    if (render_dir / skill_name).exists() and not (render_dir / skill_name).is_dir():
        raise ProjectStateError(f"{render_dir / skill_name} exists but is not a directory")


def _assert_render_ignored(project_root: Path, skill_name: str) -> None:
    """A kept render ignore file must still keep snapshots out of git."""
    try:
        probe = subprocess.run(
            ["git", "-C", str(project_root), "check-ignore", "-q", "--no-index", f"_bmad/render/{skill_name}/"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        return  # no git on this host: nothing can be committed by mistake
    except (OSError, subprocess.SubprocessError) as error:
        raise OSError(f"cannot verify the render ignore rule: {error}") from error
    if probe.returncode not in (0, 1):
        if "not a git repository" in probe.stderr:
            return  # not under version control: nothing to keep out of git
        raise OSError(f"cannot verify the render ignore rule: {probe.stderr.strip()}")
    if probe.returncode == 1:
        raise ProjectStateError(
            f"{project_root / '_bmad' / 'render' / '.gitignore'} does not ignore rendered workflow "
            "snapshots; make it a single `*` line or delete it so the runtime recreates it."
        )


def ensure_output_folders(project_root: Path, central: dict[str, Any]) -> None:
    """Create configured output folders that resolve inside this project."""
    for path in OUTPUT_SETTINGS:
        value: Any = central
        for part in path:
            value = value.get(part) if isinstance(value, dict) else None
        if not isinstance(value, str):
            continue
        raw = value.replace("{project-root}", str(project_root))
        if not Path(raw).is_absolute():
            # A relative location is read from the project root, so it must
            # stay inside it just the same.
            raw = str(project_root / raw)
        # realpath decides containment: an alias of the project path (say
        # /var vs /private/var) is inside; a link out of the project is not.
        real = Path(os.path.realpath(raw))
        if real == project_root:
            continue
        if project_root not in real.parents:
            raise ProjectStateError(
                f"`{'.'.join(path)}` = {value!r} resolves outside this project ({real}); "
                "generated work stays inside the project it belongs to"
            )
        target = Path(os.path.normpath(raw))
        _no_symlink_below(project_root, target if project_root in target.parents else real)
        target.mkdir(parents=True, exist_ok=True)


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
        _no_symlink(project_root / "_bmad")
        central = load_central_config(project_root)
        check_legacy_answers(project_root, central)
        ensure_render_root(project_root, skill_dir.name)
        ensure_output_folders(project_root, central)
        render_skill.load_central_config = load_central_config
        render_skill.load_customization = load_customization
        entry = render_skill.render(project_root, skill_dir)
    except OSError as error:
        # Exit 2: the host failed (permissions, disk, tooling), not the
        # project's settings; retrying after fixing the host can succeed.
        sys.stdout.write(f"HALT: {error}\n")
        return 2
    except config_utils.ConfigError as error:
        sys.stdout.write(f"HALT: {error}\n")
        # A settings file that could not be READ is a host failure too.
        return 2 if isinstance(error.__cause__, OSError) else 1
    except (
        render_skill.RenderError,
        ProjectStateError,
        UnicodeError,
        ValueError,
    ) as error:
        sys.stdout.write(f"HALT: {error}\n")
        return 1
    sys.stdout.write(f"read and follow {entry}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
