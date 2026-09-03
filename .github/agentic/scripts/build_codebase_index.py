#!/usr/bin/env python3
"""Build a compact codebase index from the current checkout of the default branch."""

from __future__ import annotations

import json
import os
from pathlib import Path

SKIP_DIRS = {
    ".git",
    ".next",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".vercel",
    ".turbo",
    "agent-tools",
}
SKIP_FILE_PREFIXES = (".env",)
SKIP_FILES = {".ds_store"}
MAX_FILES = 200


def iter_files(root: Path) -> list[str]:
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        rel_dir = Path(dirpath).relative_to(root)
        if any(part in SKIP_DIRS for part in rel_dir.parts):
            continue
        for name in filenames:
            if name.lower() in SKIP_FILES or name.startswith(SKIP_FILE_PREFIXES):
                continue
            rel = (rel_dir / name).as_posix()
            if rel == ".":
                continue
            files.append(rel)
            if len(files) >= MAX_FILES:
                return files
    return files


def read_package_scripts(root: Path) -> dict:
    package = root / "package.json"
    if not package.exists():
        return {}
    data = json.loads(package.read_text())
    return {
        "name": data.get("name"),
        "scripts": data.get("scripts") or {},
        "dependencies": sorted((data.get("dependencies") or {}).keys()),
        "devDependencies": sorted((data.get("devDependencies") or {}).keys()),
    }


def main() -> None:
    root = Path(os.environ.get("REPO_ROOT", ".")).resolve()
    out = Path(os.environ.get("INDEX_OUT", ".github/agentic/run/codebase-index.md"))
    snapshot = Path(os.environ.get("SNAPSHOT_OUT", ".github/agentic/codebase-index.md"))
    pkg = read_package_scripts(root)
    files = iter_files(root)

    app_files = [path for path in files if path.startswith("app/") or path.startswith("src/")]
    github_files = [path for path in files if path.startswith(".github/")]
    config_files = [
        path
        for path in files
        if path in {"package.json", "tsconfig.json", "next.config.ts", "next.config.js", "eslint.config.mjs", "README.md"}
        or path.endswith(".config.ts")
        or path.endswith(".config.js")
        or path.endswith(".config.mjs")
    ]

    lines = [
        "# Codebase index",
        "",
        "Generated from the current checkout. Agents must still open files; this is a map, not a dump.",
        "",
        "## Package",
        f"- Name: `{pkg.get('name') or root.name}`",
        f"- Scripts: {', '.join(f'`{k}`' for k in (pkg.get('scripts') or {})) or 'none'}",
        f"- Runtime deps: {', '.join(pkg.get('dependencies') or []) or 'none'}",
        "",
        "## Config files",
    ]
    lines.extend(f"- `{path}`" for path in config_files or ["(none)"])
    lines += ["", "## App / source"]
    lines.extend(f"- `{path}`" for path in app_files[:80] or ["(none)"])
    lines += ["", "## Agent and workflow files"]
    lines.extend(f"- `{path}`" for path in github_files or ["(none)"])
    lines += ["", "## File inventory (truncated)", f"- Count listed: {len(files)} (cap {MAX_FILES})"]
    lines.extend(f"- `{path}`" for path in files)

    text = "\n".join(lines) + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    if os.environ.get("WRITE_SNAPSHOT") == "1":
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        snapshot.write_text(text)
    print(f"Wrote index with {len(files)} files to {out}")


if __name__ == "__main__":
    main()
