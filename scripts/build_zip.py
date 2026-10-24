#!/usr/bin/env python3
"""Zip plugin.json + backend + ui + assets + skills for Store upload. No secrets."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "deploy"
SKIP_NAMES = {".git", "scripts", "deploy", "tests", ".gitignore", "README.md", "__pycache__"}
SKIP_SUFFIX = {".pyc", ".pyo", ".zip", ".ducky-plugin"}
SKIP_FILES = {"test_kanban.py"}  # self-check stays in the repo, not in the Store zip


def _prune_superseded_zips(keep: Path | None = None) -> None:
    """Delete every built zip but the newest: old builds only invite installing one by mistake."""
    try:
        zips = sorted(OUT_DIR.glob("*.ducky-plugin.zip"))
    except OSError:
        return
    survivor = keep or (max(zips, key=lambda p: p.stat().st_mtime) if zips else None)
    for z in zips:
        try:
            if survivor is not None and z.samefile(survivor):
                continue
            z.unlink()
        except OSError:
            pass


def build_zip(*, out: Path | None = None) -> Path:
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    pid = str(manifest.get("id") or "").strip()
    version = manifest.get("version") or 1
    if not pid:
        raise SystemExit("plugin.json missing id")
    for path in ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".dat", ".env", ".pem", ".key"}:
            raise SystemExit(f"refusing to pack secret-looking file: {path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = out or (OUT_DIR / f"{pid}-{version}.ducky-plugin.zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            rel_parts = path.relative_to(ROOT).parts
            # Repo internals never ship: dot folders (.github CI, .pytest_cache) at any depth.
            if not rel_parts or rel_parts[0] in SKIP_NAMES or any(p.startswith(".") for p in rel_parts):
                continue
            if path.suffix.lower() in SKIP_SUFFIX or path.name in SKIP_FILES or "__pycache__" in rel_parts:
                continue
            zf.writestr("/".join(rel_parts), path.read_bytes())
    raw = buf.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        bad = zf.testzip()
        if bad:
            raise SystemExit(f"built zip failed CRC for {bad} — refusing to write")
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(raw)
    tmp.replace(dest)
    print(f"wrote {dest} ({dest.stat().st_size} bytes, CRC ok)")
    _prune_superseded_zips(dest)
    return dest


if __name__ == "__main__":
    build_zip()
