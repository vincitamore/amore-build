#!/usr/bin/env python3
"""
Materialize the principle lattice into harness rules for session inject.

Why: Arcus Build (and upstream Grok Build) load project rules from a rules
directory at session start. This script regenerates those derived files from
the canonical sources under context/ so headless agents carrying the house
cwd inherit the lattice without manual inlining.

Default output target is `.arcus/rules/` (Arcus Build fork). Pass
`--grok-compat` to materialize into `.grok/rules/` for the upstream-grok lane.

Emits the lattice always, and praxis ONLY when `context/praxis.md` exists.
The 15KB praxis ceiling binds when that file lands.

Canonical sources stay under context/; the rules files are derived state —
regenerate after edits, verify with --check (exit 1 on drift).

Usage:
  python scripts/sync_orientation_rules.py
  python scripts/sync_orientation_rules.py --check
  python scripts/sync_orientation_rules.py --grok-compat
  python scripts/sync_orientation_rules.py --check --grok-compat
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PRAXIS_SIZE_CEILING_BYTES = 15 * 1024

LATTICE_HEADER_TEMPLATE = """\
<!--
GENERATED FILE — do not edit by hand.
Canonical source: context/principle-lattice.md
Regenerate: python scripts/sync_orientation_rules.py{flag}
Loaded as a project rule ({rules_rel}/) at session start.
-->

"""

PRAXIS_HEADER_TEMPLATE = """\
<!--
GENERATED FILE — do not edit by hand.
Canonical source: context/praxis.md
Regenerate: python scripts/sync_orientation_rules.py{flag}
Loaded as a project rule ({rules_rel}/) at session start.
-->

"""


def find_org_root() -> Path:
    """Resolve house root via ORG_ROOT env or walk-up markers (AGENTS.md + tasks/)."""
    env_root = os.environ.get("ORG_ROOT")
    if env_root:
        p = Path(env_root).resolve()
        if p.exists():
            return p
    cwd = Path.cwd().resolve()
    for parent in [cwd] + list(cwd.parents):
        if (parent / "AGENTS.md").exists() and (parent / "tasks").is_dir():
            return parent
    # Fallback: AGENTS.md + context/ (minimal orientation without tasks yet)
    for parent in [cwd] + list(cwd.parents):
        if (parent / "AGENTS.md").exists() and (parent / "context").is_dir():
            return parent
    return cwd


def rules_rel_for(grok_compat: bool) -> str:
    return ".grok/rules" if grok_compat else ".arcus/rules"


def rules_dir_for(org_root: Path, grok_compat: bool) -> Path:
    if grok_compat:
        return org_root / ".grok" / "rules"
    return org_root / ".arcus" / "rules"


def flag_suffix(grok_compat: bool) -> str:
    return " --grok-compat" if grok_compat else ""


def extract_principle_lattice_section(raw: str) -> str:
    """Full ## Principle Lattice section through EOF (lattice file is one section)."""
    marker = "## Principle Lattice"
    idx = raw.find(marker)
    if idx < 0:
        body = raw
        if "-->" in body:
            body = body.split("-->", 1)[-1].strip()
        return body.strip()
    return raw[idx:].strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def lattice_source(org_root: Path) -> Path:
    return org_root / "context" / "principle-lattice.md"


def build_lattice_rules(org_root: Path, grok_compat: bool) -> tuple[str, dict]:
    """Build the derived lattice rules file.

    Callers must check :func:`lattice_source` first — the lattice is optional
    (``arcus init --no-lattice``), and a house without one is correctly
    configured, not broken.
    """
    src = lattice_source(org_root)
    if not src.exists():
        raise FileNotFoundError(f"missing {src}")
    raw = src.read_text(encoding="utf-8", errors="replace")
    body = extract_principle_lattice_section(raw)
    header = LATTICE_HEADER_TEMPLATE.format(
        flag=flag_suffix(grok_compat),
        rules_rel=rules_rel_for(grok_compat),
    )
    out = header + body + "\n"
    meta = {
        "source": str(src.relative_to(org_root)).replace("\\", "/"),
        "body_bytes": len(body.encode("utf-8")),
        "out_bytes": len(out.encode("utf-8")),
        "hash": content_hash(body),
        "glyphs": len(re.findall(r"^### ", body, re.M)),
    }
    return out, meta


def build_praxis_rules(org_root: Path, grok_compat: bool) -> tuple[str, dict]:
    src = org_root / "context" / "praxis.md"
    if not src.exists():
        raise FileNotFoundError(f"missing {src}")
    size = src.stat().st_size
    if size > PRAXIS_SIZE_CEILING_BYTES:
        raise RuntimeError(
            f"PRAXIS OVERSIZE: {src} is {size} bytes "
            f"(ceiling {PRAXIS_SIZE_CEILING_BYTES}). Demote entries before sync."
        )
    body = src.read_text(encoding="utf-8", errors="replace").strip()
    header = PRAXIS_HEADER_TEMPLATE.format(
        flag=flag_suffix(grok_compat),
        rules_rel=rules_rel_for(grok_compat),
    )
    out = header + body + "\n"
    meta = {
        "source": str(src.relative_to(org_root)).replace("\\", "/"),
        "body_bytes": len(body.encode("utf-8")),
        "out_bytes": len(out.encode("utf-8")),
        "hash": content_hash(body),
    }
    return out, meta


def write_if_changed(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def sync(org_root: Path, grok_compat: bool) -> dict:
    rules_dir = rules_dir_for(org_root, grok_compat)
    has_lattice = lattice_source(org_root).exists()
    has_praxis = (org_root / "context" / "praxis.md").exists()
    lattice_path = rules_dir / "principle-lattice.md"
    praxis_path = rules_dir / "praxis.md"
    result: dict = {"rules_dir": str(rules_dir)}
    if has_lattice:
        lattice_text, lattice_meta = build_lattice_rules(org_root, grok_compat)
        result["lattice"] = {
            **lattice_meta,
            "path": str(lattice_path.relative_to(org_root)).replace("\\", "/"),
            "changed": write_if_changed(lattice_path, lattice_text),
        }
    else:
        result["lattice"] = None
        if lattice_path.exists():  # source retired locally: drop the derived file
            lattice_path.unlink()
    if has_praxis:
        praxis_text, praxis_meta = build_praxis_rules(org_root, grok_compat)
        result["praxis"] = {
            **praxis_meta,
            "path": str(praxis_path.relative_to(org_root)).replace("\\", "/"),
            "changed": write_if_changed(praxis_path, praxis_text),
        }
    else:
        result["praxis"] = None
        if praxis_path.exists():  # source retired locally: drop the derived file
            praxis_path.unlink()
    return result


def check(org_root: Path, grok_compat: bool) -> int:
    """Return 0 if rules match sources, 1 if drift or missing."""
    rules_dir = rules_dir_for(org_root, grok_compat)
    has_lattice = lattice_source(org_root).exists()
    has_praxis = (org_root / "context" / "praxis.md").exists()
    lattice_text = (
        build_lattice_rules(org_root, grok_compat)[0] if has_lattice else None
    )
    praxis_text = (
        build_praxis_rules(org_root, grok_compat)[0] if has_praxis else None
    )
    ok = True
    pairs = []
    if lattice_text is not None:
        pairs.append(("principle-lattice.md", lattice_text))
    else:
        print("SKIP principle-lattice.md (no context/principle-lattice.md)")
    if praxis_text is not None:
        pairs.append(("praxis.md", praxis_text))
    for name, expected in pairs:
        path = rules_dir / name
        if not path.exists():
            print(f"MISSING {path.relative_to(org_root).as_posix()}", file=sys.stderr)
            ok = False
            continue
        actual = path.read_text(encoding="utf-8")
        if actual != expected:
            print(f"DRIFT {path.relative_to(org_root).as_posix()}", file=sys.stderr)
            ok = False
        else:
            print(f"OK {path.relative_to(org_root).as_posix()}")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit 1 if derived rules files drift from context sources",
    )
    parser.add_argument(
        "--grok-compat",
        action="store_true",
        help="Materialize into .grok/rules/ (upstream-grok lane) instead of .arcus/rules/",
    )
    args = parser.parse_args()
    org_root = find_org_root()
    if args.check:
        raise SystemExit(check(org_root, args.grok_compat))
    result = sync(org_root, args.grok_compat)
    keys = ("lattice", "praxis") if result.get("praxis") else ("lattice",)
    for key in keys:
        m = result[key]
        flag = "updated" if m["changed"] else "unchanged"
        print(f"{m['path']}: {flag} ({m['body_bytes']} body bytes, hash={m['hash']})")
    if not result.get("praxis"):
        print("praxis: no context/praxis.md — skipped")
    print(f"lattice ### headers: {result['lattice']['glyphs']}")


if __name__ == "__main__":
    main()
